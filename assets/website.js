console.log('No-Punks JS booted'); // sanity

/* ---------- Tabs (event delegation = reliable) ---------- */
function activate(targetId){
  document.querySelectorAll('.tab')
    .forEach(b => b.classList.toggle('active', b.dataset.target === targetId));
  document.querySelectorAll('.section')
    .forEach(s => s.classList.toggle('active', s.id === targetId));
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  const targetId = btn.dataset.target;
  if (!targetId) return;
  activate(targetId);
  if (targetId === 'collection' && !document.getElementById('grid').childElementCount) {
    loadRange(0);
  }
});

/* ---------- Collection from /collection ---------- */
const TOTAL = 10000;  // 0..9999
const COUNT = 100;
let start = 0;

const grid  = document.getElementById('grid');
const label = document.getElementById('label');
const tip   = document.getElementById('tooltip');
const metaCache = new Map();

function clampStart(x){
  if (x < 0) return 0;
  const maxStart = Math.max(0, TOTAL - COUNT);
  return Math.min(x, maxStart);
}

async function getMeta(id){
  if (metaCache.has(id)) return metaCache.get(id);
  try{
    const r = await fetch(`/collection/${id}.json`, { cache: 'force-cache' });
    if (!r.ok) throw new Error('missing json');
    const j = await r.json();
    metaCache.set(id, j);
    return j;
  }catch{
    const fallback = { name:`No-Punk #${id}`, attributes:[] };
    metaCache.set(id, fallback);
    return fallback;
  }
}

function traitText(meta){
  const attrs = meta.attributes || meta.traits || [];
  if (!Array.isArray(attrs) || !attrs.length) return '';
  return attrs.map(a => `${a.trait_type ?? a.type ?? 'Trait'}: ${a.value}`).join('\n');
}

function showTip(x, y, html){
  tip.innerHTML = html;
  tip.style.left = (x + 14) + 'px';
  tip.style.top  = (y + 14) + 'px';
  tip.style.display = 'block';
}
function hideTip(){ tip.style.display = 'none'; }

function tile(id){
  const a = document.createElement('a');
  a.className = 'tile';
  a.href = `/collection/${id}.png`;
  a.target = '_blank';
  a.rel = 'noopener';
  a.innerHTML = `
    <span class="num">#${id}</span>
    <img alt="No-Punk #${id}" loading="lazy" src="/collection/${id}.png">
  `;

  a.querySelector('img').addEventListener('error', ()=> { a.style.display='none'; });

  const move = async (e)=>{
    const p = e.touches ? e.touches[0] : e;
    const meta = await getMeta(id);
    const name = meta.name || `No-Punk #${id}`;
    const traits = traitText(meta);
    const html = `<h4>${name}</h4>${traits ? traits.replace(/\n/g,'<br>') : 'No traits'}`;
    showTip(p.clientX, p.clientY, html);
  };
  a.addEventListener('mouseenter', move);
  a.addEventListener('mousemove', move);
  a.addEventListener('mouseleave', hideTip);
  a.addEventListener('touchstart', move, {passive:true});
  a.addEventListener('touchmove', move, {passive:true});
  a.addEventListener('touchend', hideTip);

  return a;
}

async function loadRange(s){
  start = clampStart(s);
  if (label) label.textContent = `${start} – ${start + COUNT - 1}`;
  grid.innerHTML = '';
  const ids = Array.from({length: COUNT}, (_,k)=> start + k);
  for (const id of ids){
    grid.appendChild(tile(id));
  }
}

document.getElementById('prev').addEventListener('click', ()=> loadRange(start - COUNT));
document.getElementById('next').addEventListener('click', ()=> loadRange(start + COUNT));

window.addEventListener('DOMContentLoaded', ()=>{
  activate('collection');
  loadRange(0);
});