import { useState, useEffect, useRef } from "react";

const HM = {
  'tv_rt_z':'TV RT(U64)','vod_rt_logz':'VOD RT(ALL)',
  'tv_ts_z':'TV TS(U64)','vod_ts_logz':'VOD TS(ALL)',
  'fav_z':'好感度','awa_z':'認知度','att_z':'注目度',
  'enj_fun_z':'楽しい','enj_fam_z':'親しみ','enj_rew_z':'見応え',
  'enj_mov_z':'感動','enj_emp_z':'共感','enj_con_z':'良心的',
  'enj_who_z':'健全','val_knw_z':'知識','val_top_z':'話題',
  'val_use_z':'役立つ','val_edu_z':'教えられる','nov_fre_z':'新鮮さ',
  'nov_dis_z':'個性的','nov_sti_z':'刺激的','nov_thr_z':'ハラハラ',
  'ret_z':'継続率','prev_tv_rt_rate_z':'前枠視聴率',
  'tv_rt_rate_z':'TV RT(U64)','vod_rt_imp_logz':'VOD RT(ALL)',
  'tv_ts_rate_z':'TV TS(U64)','vod_ts_imp_logz':'VOD TS(ALL)',
  'aware_z':'認知度',
};
const lbl = v => HM[v] || v;

const LATENT_COLORS = [
  { fill: '#e8837c', stroke: '#c04040' },
  { fill: '#7ca8e8', stroke: '#3060b0' },
  { fill: '#7dcea0', stroke: '#2e8b57' },
  { fill: '#c39bd3', stroke: '#7d3c98' },
  { fill: '#f0b27a', stroke: '#ca6f1e' },
  { fill: '#76d7c4', stroke: '#1a8a7a' },
  { fill: '#f1948a', stroke: '#a93226' },
  { fill: '#aab7b8', stroke: '#5d6d7e' },
];

const DEFAULT_MODEL = `### Measurement
Quality =~ enj_rew_z + enj_mov_z + nov_fre_z
Entertainment =~ enj_fun_z + enj_fam_z
Quality ~~ Entertainment
### Structural
fav_z ~ awa_z + Quality + Entertainment`;

const NODE_W = 90;
const NODE_H = 18;
const LAT_RX = 58;
const LAT_RY = 32;
const OBS_PAD_X = 16;
const OBS_PAD_Y = 20;
const LAT_PAD_Y = 50;

function parseModel(text) {
  const m = text.match(/r?"""([\s\S]*?)"""/);
  const src = m ? m[1] : text;
  const latentVars = new Set();
  const observedVars = new Set();
  const measureEdges = [];
  const structEdges = [];
  const covEdges = [];

  for (let raw of src.split('\n')) {
    const line = raw.replace(/#.*/,'').trim();
    if (!line) continue;
    if (line.includes('=~')) {
      const [l, r] = line.split('=~');
      const lv = l.trim();
      latentVars.add(lv);
      r.split('+').map(v=>v.trim()).filter(Boolean).forEach(v => {
        measureEdges.push({ from: lv, to: v });
      });
    } else if (line.includes('~~')) {
      const [l, r] = line.split('~~');
      const a = l.trim(), b = r.trim();
      if (a && b) covEdges.push({ from: a, to: b });
    } else if (line.includes('~')) {
      const [l, r] = line.split('~');
      const dep = l.trim();
      r.split('+').map(v=>v.trim()).filter(Boolean).forEach(v => {
        structEdges.push({ from: v, to: dep });
      });
    }
  }

  const allVars = new Set([
    ...measureEdges.map(e=>e.to),
    ...structEdges.map(e=>e.from),
    ...structEdges.map(e=>e.to),
    ...covEdges.map(e=>e.from),
    ...covEdges.map(e=>e.to),
  ]);
  allVars.forEach(v => { if (!latentVars.has(v)) observedVars.add(v); });

  return { latentVars, observedVars, measureEdges, structEdges, covEdges };
}

function computeLayout(parsed, W, H) {
  const { latentVars, measureEdges, structEdges } = parsed;
  const nodes = {};
  const latArr = [...latentVars];

  const latObsMap = {};
  latArr.forEach(lv => { latObsMap[lv] = []; });
  measureEdges.forEach(e => { if (latObsMap[e.from] !== undefined) latObsMap[e.from].push(e.to); });

  const groupHeights = latArr.map(lv => {
    const n = latObsMap[lv].length;
    return Math.max(LAT_RY * 2 + 20, n * (NODE_H * 2 + OBS_PAD_Y) - OBS_PAD_Y + 20);
  });
  const totalH = groupHeights.reduce((a,b)=>a+b, 0) + (latArr.length - 1) * LAT_PAD_Y;

  let curY = H / 2 - totalH / 2;
  const cx = W * 0.46;

  latArr.forEach((lv, gi) => {
    const gh = groupHeights[gi];
    const groupCenterY = curY + gh / 2;
    nodes[lv] = { id: lv, type: 'latent', x: cx, y: groupCenterY };

    const inds = latObsMap[lv];
    const indBlockH = inds.length * (NODE_H * 2 + OBS_PAD_Y) - OBS_PAD_Y;
    const indY0 = groupCenterY - indBlockH / 2 + NODE_H;
    inds.forEach((v, i) => {
      nodes[v] = { id: v, type: 'observed', x: cx - 220, y: indY0 + i * (NODE_H * 2 + OBS_PAD_Y) };
    });

    curY += gh + LAT_PAD_Y;
  });

  const placed = new Set(Object.keys(nodes));
  const rightAll = [...new Set([
    ...structEdges.map(e=>e.to).filter(v => !latentVars.has(v) && !placed.has(v)),
    ...structEdges.map(e=>e.from).filter(v => !latentVars.has(v) && !placed.has(v)),
  ])];

  const latCenterY = latArr.length > 0
    ? latArr.reduce((s, v) => s + nodes[v].y, 0) / latArr.length
    : H / 2;

  const rn = rightAll.length;
  if (rn > 0) {
    // Always place in a single column but with large vertical spread
    // so arrows fan out clearly
    const totalSpread = Math.min(H * 0.75, rn * 90);
    const sp = rn > 1 ? totalSpread / (rn - 1) : 0;
    const startY = latCenterY - totalSpread / 2;
    rightAll.forEach((v, i) => {
      nodes[v] = {
        id: v, type: 'observed',
        x: cx + 260,
        y: rn === 1 ? latCenterY : startY + i * sp,
      };
    });
  }

  return nodes;
}

function calcLatRx(latArr) {
  return latArr.reduce((max, v) => Math.max(max, Math.max(LAT_RX, lbl(v).length * 7 + 16)), LAT_RX);
}

function edgePt(n, tx, ty, gap, latRx) {
  const _gap = gap !== undefined ? gap : 8;
  const _latRx = latRx !== undefined ? latRx : LAT_RX;
  const dx = tx - n.x, dy = ty - n.y;
  const len = Math.sqrt(dx*dx + dy*dy) || 1;
  let bx, by;
  if (n.type === 'latent') {
    const rx = _latRx, ry = LAT_RY;
    const angle = Math.atan2(dy * rx, dx * ry);
    bx = n.x + Math.cos(angle) * rx;
    by = n.y + Math.sin(angle) * ry;
  } else {
    const lbT = lbl(n.id);
    const hw = Math.max(NODE_W/2, lbT.length*5+OBS_PAD_X);
    const hh = NODE_H;
    const scaleW = hw / (Math.abs(dx)||0.001);
    const scaleH = hh / (Math.abs(dy)||0.001);
    const s = Math.min(scaleW, scaleH);
    bx = n.x + dx*s;
    by = n.y + dy*s;
  }
  return { x: bx + (dx/len)*_gap, y: by + (dy/len)*_gap };
}

function NodeShape({ n, latArr, latRx }) {
  const lbText = lbl(n.id);
  if (n.type === 'latent') {
    const idx = latArr.indexOf(n.id);
    const { fill, stroke } = LATENT_COLORS[idx % LATENT_COLORS.length];
    return (
      <g>
        <ellipse rx={latRx} ry={LAT_RY} fill={fill} stroke={stroke} strokeWidth={1.5} filter="url(#sh)"/>
        <text textAnchor="middle" dominantBaseline="middle"
          fill="#fff" fontSize={13} fontWeight={700}
          fontFamily="'Hiragino Sans','Meiryo',sans-serif">{lbText}</text>
      </g>
    );
  }
  const hw = Math.max(NODE_W/2, lbText.length*5+OBS_PAD_X);
  return (
    <g>
      <rect x={-hw} y={-NODE_H} width={hw*2} height={NODE_H*2} rx={4}
        fill="#d8d8d8" stroke="#b0b0b0" strokeWidth={1} filter="url(#sh)"/>
      <text textAnchor="middle" dominantBaseline="middle"
        fill="#333" fontSize={11}
        fontFamily="'Hiragino Sans','Meiryo',sans-serif">{lbText}</text>
    </g>
  );
}

export default function SEMDiagram() {
  const [modelText, setModelText] = useState(DEFAULT_MODEL);
  const [diagram, setDiagram] = useState(null);
  const [status, setStatus] = useState('Ready — Draw を押してください');
  const [viewBox, setViewBox] = useState({ x:0, y:0, w:900, h:560 });
  const svgRef = useRef(null);
  const dragging = useRef(null);
  const panStart = useRef(null);
  const [, setTick] = useState(0);
  const W=900, H=560;

  function doDraw(text) {
    try {
      const parsed = parseModel(text);
      const nodes = computeLayout(parsed, W, H);
      setDiagram({ parsed, nodes });
      setViewBox({ x:0, y:0, w:W, h:H });
      setStatus(`合成指標 ${parsed.latentVars.size}  観測指標 ${parsed.observedVars.size}  ／  合成矢印 ${parsed.measureEdges.length}  影響矢印 ${parsed.structEdges.length}  共分散 ${parsed.covEdges.length}`);
    } catch(e) { setStatus('Parse error: ' + e.message); }
  }

  function doReset() {
    setModelText(DEFAULT_MODEL);
    doDraw(DEFAULT_MODEL);
  }

  function doExport() {
    if (!diagram) return;
    const { parsed, nodes } = diagram;
    const latArr = parsed ? [...parsed.latentVars] : [];
    const latRx = calcLatRx(latArr);
    const PADDING = 40;

    let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
    Object.values(nodes).forEach(n => {
      const lbText = lbl(n.id);
      const hw = n.type==='latent' ? latRx : Math.max(NODE_W/2, lbText.length*5+OBS_PAD_X);
      const hh = n.type==='latent' ? LAT_RY : NODE_H;
      minX = Math.min(minX, n.x-hw); minY = Math.min(minY, n.y-hh);
      maxX = Math.max(maxX, n.x+hw); maxY = Math.max(maxY, n.y+hh);
    });

    const vbX=minX-PADDING, vbY=minY-PADDING;
    const vbW=maxX-minX+PADDING*2, vbH=maxY-minY+PADDING*2;
    const scale=2;

    const svgEl = svgRef.current;
    const clone = svgEl.cloneNode(true);
    clone.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);
    clone.setAttribute('width', vbW*scale);
    clone.setAttribute('height', vbH*scale);
    clone.querySelectorAll('rect').forEach(r => {
      if (r.getAttribute('fill')==='url(#grid)') r.remove();
    });
    clone.style.background = 'transparent';

    const svgStr = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([svgStr], { type:'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = vbW*scale;
      canvas.height = vbH*scale;
      canvas.getContext('2d').drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob(b2 => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(b2);
        a.download = 'sem_path_diagram.png';
        a.click();
      }, 'image/png');
    };
    img.src = url;
  }

  useEffect(() => { doDraw(DEFAULT_MODEL); }, []);

  const onNodeMD = (e, id) => { e.stopPropagation(); dragging.current = id; };
  const onSvgMD  = (e) => { if (!dragging.current) panStart.current = { mx:e.clientX, my:e.clientY, vb:{...viewBox} }; };
  const onMM = (e) => {
    if (dragging.current) {
      const svg = svgRef.current; if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const sx=viewBox.w/rect.width, sy=viewBox.h/rect.height;
      const id = dragging.current;
      setDiagram(prev => {
        if (!prev) return prev;
        return { ...prev, nodes: { ...prev.nodes, [id]: { ...prev.nodes[id], x:prev.nodes[id].x+e.movementX*sx, y:prev.nodes[id].y+e.movementY*sy } } };
      });
      setTick(t=>t+1);
    } else if (panStart.current) {
      const svg = svgRef.current; if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const dx=(e.clientX-panStart.current.mx)*(viewBox.w/rect.width);
      const dy=(e.clientY-panStart.current.my)*(viewBox.h/rect.height);
      setViewBox({ ...panStart.current.vb, x:panStart.current.vb.x-dx, y:panStart.current.vb.y-dy });
    }
  };
  const onMU = () => { dragging.current=null; panStart.current=null; };
  const onWheel = (e) => {
    e.preventDefault();
    const f=e.deltaY>0?1.12:0.88;
    const svg=svgRef.current; if (!svg) return;
    const rect=svg.getBoundingClientRect();
    const mx=(e.clientX-rect.left)/rect.width*viewBox.w+viewBox.x;
    const my=(e.clientY-rect.top)/rect.height*viewBox.h+viewBox.y;
    setViewBox({ x:mx-(mx-viewBox.x)*f, y:my-(my-viewBox.y)*f, w:viewBox.w*f, h:viewBox.h*f });
  };

  const { parsed, nodes } = diagram || {};
  const latArr = parsed ? [...parsed.latentVars] : [];
  const latRx = calcLatRx(latArr);

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', background:'#f5f6f8', fontFamily:"'Hiragino Sans','Meiryo',sans-serif" }}>

      {/* Header */}
      <div style={{ padding:'7px 16px', borderBottom:'1px solid #ddd', display:'flex', alignItems:'center', gap:10, background:'#fff', flexWrap:'wrap' }}>
        <span style={{ fontSize:11, fontWeight:700, color:'#c04040', border:'1px solid #e08080', borderRadius:3, padding:'2px 8px' }}>SEM</span>
        <span style={{ fontSize:13, color:'#444', fontWeight:500 }}>パス図ビジュアライザ</span>

        <div style={{ display:'flex', gap:14, alignItems:'center', fontSize:11, color:'#555', marginLeft:14 }}>
          <span style={{ display:'flex', alignItems:'center', gap:4 }}>
            <svg width={30} height={16}><ellipse cx={15} cy={8} rx={13} ry={7} fill="#e8837c" stroke="#c04040" strokeWidth={1.2}/></svg>
            <span style={{ color:'#c04040', fontWeight:600 }}>合成指標</span>
          </span>
          <span style={{ display:'flex', alignItems:'center', gap:4 }}>
            <svg width={26} height={16}><rect x={1} y={2} width={24} height={12} rx={3} fill="#d8d8d8" stroke="#b0b0b0" strokeWidth={1}/></svg>
            観測指標
          </span>
          <span style={{ display:'flex', alignItems:'center', gap:4 }}>
            <svg width={36} height={14}>
              <defs><marker id="lg-r" viewBox="0 -3 8 6" refX={7} refY={0} markerWidth={5} markerHeight={5} orient="auto"><path d="M0,-3L8,0L0,3" fill="#c04040"/></marker></defs>
              <line x1={2} y1={7} x2={30} y2={7} stroke="#c04040" strokeWidth={1.8} markerEnd="url(#lg-r)"/>
            </svg>
            合成矢印
          </span>
          <span style={{ display:'flex', alignItems:'center', gap:4 }}>
            <svg width={36} height={14}>
              <defs><marker id="lg-g" viewBox="0 -3 8 6" refX={7} refY={0} markerWidth={5} markerHeight={5} orient="auto"><path d="M0,-3L8,0L0,3" fill="#888"/></marker></defs>
              <line x1={2} y1={7} x2={30} y2={7} stroke="#888" strokeWidth={1.8} markerEnd="url(#lg-g)"/>
            </svg>
            影響矢印
          </span>
          <span style={{ display:'flex', alignItems:'center', gap:4 }}>
            <svg width={36} height={14}>
              <defs>
                <marker id="lg-gb" viewBox="0 -3 8 6" refX={7} refY={0} markerWidth={5} markerHeight={5} orient="auto"><path d="M0,-3L8,0L0,3" fill="#888"/></marker>
                <marker id="lg-gs" viewBox="0 -3 8 6" refX={1} refY={0} markerWidth={5} markerHeight={5} orient="auto-start-reverse"><path d="M0,-3L8,0L0,3" fill="#888"/></marker>
              </defs>
              <line x1={2} y1={7} x2={30} y2={7} stroke="#888" strokeWidth={1.8} markerEnd="url(#lg-gb)" markerStart="url(#lg-gs)"/>
            </svg>
            共分散
          </span>
        </div>

        <div style={{ marginLeft:'auto', display:'flex', gap:8 }}>
          <button onClick={() => doDraw(modelText)}
            style={{ background:'#c04040', color:'#fff', border:'none', borderRadius:4, padding:'6px 20px', fontSize:12, fontWeight:600, cursor:'pointer' }}>
            ▶ Draw
          </button>
          <button onClick={doReset}
            style={{ background:'#eee', color:'#555', border:'1px solid #ccc', borderRadius:4, padding:'6px 14px', fontSize:12, cursor:'pointer' }}>
            Reset
          </button>
          <button onClick={doExport}
            style={{ background:'#2a6630', color:'#fff', border:'none', borderRadius:4, padding:'6px 14px', fontSize:12, cursor:'pointer' }}>
            ↓ PNG
          </button>
        </div>
      </div>

      <div style={{ display:'flex', flex:1, overflow:'hidden' }}>
        <div style={{ width:270, display:'flex', flexDirection:'column', borderRight:'1px solid #ddd', background:'#fff' }}>
          <div style={{ fontSize:10, color:'#bbb', padding:'7px 12px 5px', borderBottom:'1px solid #eee', textTransform:'uppercase', letterSpacing:'0.1em' }}>Model Syntax</div>
          <textarea
            value={modelText}
            onChange={e => setModelText(e.target.value)}
            style={{ flex:1, background:'#fafafa', color:'#1a5c28', fontFamily:'monospace', fontSize:12, lineHeight:1.75, padding:12, border:'none', resize:'none', outline:'none' }}
            spellCheck={false}
          />
        </div>

        <div style={{ flex:1, overflow:'hidden' }}>
          <svg ref={svgRef} width="100%" height="100%"
            viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
            onMouseDown={onSvgMD} onMouseMove={onMM} onMouseUp={onMU}
            onMouseLeave={onMU} onWheel={onWheel}
            style={{ cursor:'grab', background:'#f5f6f8' }}>
            <defs>
              <filter id="sh" x="-25%" y="-35%" width="150%" height="170%">
                <feDropShadow dx={0} dy={1.5} stdDeviation={2} floodColor="#00000015"/>
              </filter>
              <pattern id="grid" width={40} height={40} patternUnits="userSpaceOnUse">
                <path d="M40,0L0,0 0,40" fill="none" stroke="#e4e6ea" strokeWidth={0.5}/>
              </pattern>
              <marker id="arr-red" viewBox="0 -4 10 8" refX={8} refY={0} markerWidth={6} markerHeight={6} orient="auto">
                <path d="M0,-4L10,0L0,4" fill="#c04040"/>
              </marker>
              <marker id="arr-gray" viewBox="0 -4 10 8" refX={8} refY={0} markerWidth={6} markerHeight={6} orient="auto">
                <path d="M0,-4L10,0L0,4" fill="#888"/>
              </marker>
              <marker id="arr-gray-s" viewBox="0 -4 10 8" refX={2} refY={0} markerWidth={6} markerHeight={6} orient="auto-start-reverse">
                <path d="M0,-4L10,0L0,4" fill="#888"/>
              </marker>
            </defs>

            <rect x={-W} y={-H} width={W*4} height={H*4} fill="url(#grid)"/>

            {parsed && nodes && <>
              {/* 合成矢印: latent → obs 赤 */}
              {parsed.measureEdges.map((e, i) => {
                const lat = nodes[e.from], obs = nodes[e.to];
                if (!lat || !obs) return null;
                const sp = edgePt(lat, obs.x, obs.y, 6, latRx);
                const tp = edgePt(obs, lat.x, lat.y, 12, latRx);
                return <line key={`m${i}`} x1={sp.x} y1={sp.y} x2={tp.x} y2={tp.y}
                  stroke="#c04040" strokeWidth={1.5} markerEnd="url(#arr-red)"/>;
              })}

              {/* 影響矢印: x → y グレー */}
              {parsed.structEdges.map((e, i) => {
                const s = nodes[e.from], t = nodes[e.to];
                if (!s || !t) return null;
                const sp = edgePt(s, t.x, t.y, 6, latRx);
                const tp = edgePt(t, s.x, s.y, 12, latRx);
                return <line key={`s${i}`} x1={sp.x} y1={sp.y} x2={tp.x} y2={tp.y}
                  stroke="#888" strokeWidth={1.5} markerEnd="url(#arr-gray)"/>;
              })}

              {/* 共分散: 両端矢印 曲線グレー */}
              {parsed.covEdges.map((e, i) => {
                const s = nodes[e.from], t = nodes[e.to];
                if (!s || !t) return null;
                const sp = edgePt(s, t.x, t.y, 12, latRx);
                const tp = edgePt(t, s.x, s.y, 12, latRx);
                const mx=(sp.x+tp.x)/2 - Math.abs(tp.y-sp.y)*0.3;
                const my=(sp.y+tp.y)/2;
                return <path key={`c${i}`}
                  d={`M${sp.x},${sp.y} Q${mx},${my} ${tp.x},${tp.y}`}
                  stroke="#888" strokeWidth={1.4} fill="none"
                  markerEnd="url(#arr-gray)" markerStart="url(#arr-gray-s)"/>;
              })}

              {/* Nodes */}
              {Object.values(nodes).map(n => (
                <g key={n.id} transform={`translate(${n.x},${n.y})`}
                  style={{ cursor:'grab', userSelect:'none' }}
                  onMouseDown={e => onNodeMD(e, n.id)}>
                  <NodeShape n={n} latArr={latArr} latRx={latRx}/>
                </g>
              ))}
            </>}

            {!diagram && (
              <text x={W/2} y={H/2} textAnchor="middle" fill="#ccc" fontSize={14}>
                ← モデルを入力して Draw を押してください
              </text>
            )}
          </svg>
        </div>
      </div>

      <div style={{ padding:'4px 16px', borderTop:'1px solid #ddd', fontSize:10, color:'#aaa', background:'#f0f2f5', fontFamily:'monospace' }}>
        {status}
      </div>
    </div>
  );
}
