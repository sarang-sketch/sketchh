// W3 contrast check — WCAG 2 ratios for the dark theme's key text/UI pairs.
// Read-only: it only computes ratios from the token values in global.css so the fix
// doc can list measured numbers. Not part of the app build.
function hex(s){const h=s.replace('#','');const n=h.length===3?[...h].map(c=>c+c).join(''):h;return [0,2,4].map(i=>parseInt(n.slice(i,i+2),16));}
function toLin(c){c/=255;return c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;}
function lum([r,g,b]){return 0.2126*toLin(r)+0.7152*toLin(g)+0.0722*toLin(b);}
function ratio(a,b){const [hi,lo]=[lum(hex(a)),lum(hex(b))].sort((x,y)=>y-x);return (hi+0.05)/(lo+0.05);}
// Dark theme token values (from :root in global.css)
const t={
  bgPrimary:'#121212', bgSecondary:'#171717', bgSurface:'#1e1e1e', bgElevated:'#262626',
  textPrimary:'#f5f5f5', textSecondary:'#a3a3a3', textMuted:'#8a8a8a', textDisabled:'#5a5a5a',
  accent:'#f97316', accentFill:'#cf4409', accentFillHover:'#c2410c', accentStrong:'#f97316',
  success:'#22c55e', warning:'#eab308', error:'#ef4444', info:'#3b82f6', white:'#ffffff',
};
const pairs=[
  ['text-primary','textPrimary','bg-primary','bgPrimary'],
  ['text-primary','textPrimary','bg-secondary','bgSecondary'],
  ['text-primary','textPrimary','bg-surface','bgSurface'],
  ['text-secondary','textSecondary','bg-primary','bgPrimary'],
  ['text-secondary','textSecondary','bg-secondary','bgSecondary'],
  ['text-muted','textMuted','bg-primary','bgPrimary'],
  ['text-muted','textMuted','bg-surface','bgSurface'],
  ['window controls (was #64748b) now text-secondary','textSecondary','title bar bg-primary','bgPrimary'],
  ['accent','accent','bg-primary','bgPrimary'],
  ['accent','accent','bg-surface','bgSurface'],
  ['success','success','bg-primary','bgPrimary'],
  ['warning','warning','bg-primary','bgPrimary'],
  ['error','error','bg-primary','bgPrimary'],
  ['info','info','bg-primary','bgPrimary'],
  ['white on accent-fill (primary btn)','white','accent-fill','accentFill'],
  ['white on accent-fill-hover','white','accent-fill-hover','accentFillHover'],
];
console.log('pair | ratio | AA normal(4.5) | AA large/UI(3.0)');
for(const [fn,fk,bn,bk] of pairs){
  const r=ratio(t[fk],t[bk]);
  console.log(`${fn} on ${bn} | ${r.toFixed(2)}:1 | ${r>=4.5?'PASS':'fail'} | ${r>=3?'PASS':'fail'}`);
}
// The OLD faint window-control colour, for the before/after note.
console.log(`\nBEFORE: old window-control #64748b on #121212 = ${ratio('#64748b','#121212').toFixed(2)}:1`);
