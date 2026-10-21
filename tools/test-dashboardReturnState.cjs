const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const stored = new Map(); const sessionStorage = { getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value) };
function load(file, imports, globals = {}) { const exports = {}; vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports, require: name => { if (!(name in imports)) throw Error(name); return imports[name]; }, sessionStorage, URL, process, console, ...globals }); return exports; }
const tabs = load('src/lib/tabs.ts', {});
const core = load('src/lib/dashboardReturnState.ts', { './tabs': tabs });
assert.notEqual(core.returnKey('a:b','c','x'), core.returnKey('a','b:c','x'));
assert.equal(core.validTabReturn('/dispatch?tab=jobs&q=foo','dispatch'), '/dispatch?tab=jobs&q=foo');
for (const bad of ['https://other.test/dispatch','//other.test/dispatch','/payroll','/dispatch?token=secret']) assert.equal(core.validTabReturn(bad,'dispatch'),null);
stored.set(core.returnKey('userA','companyA','tab:dispatch'), JSON.stringify('/dispatch?tab=completed'));
assert.equal(core.rememberedTabHref('userA','companyA','dispatch','/dispatch'), '/dispatch?tab=completed');
assert.equal(core.rememberedTabHref('userA','companyB','dispatch','/dispatch'), '/dispatch');

const events = new Map(), frames = new Map(); let frameId = 0, layout;
const add = (name, fn) => { const rows = events.get(name) || new Set(); rows.add(fn); events.set(name, rows); };
const remove = (name, fn) => events.get(name)?.delete(fn);
const emit = name => [...(events.get(name) || [])].forEach(fn => fn());
const element = id => ({ dataset: { dashboardScroll: id }, scrollTop: 0, scrollLeft: 0, scrollHeight: 100, clientHeight: 100, scrollWidth: 100, clientWidth: 100, getClientRects: () => [1] });
const main = element('dispatch'), jobs = element('dispatch-jobs'), scrolling = element('window');
const document = { body: {}, scrollingElement: scrolling, querySelectorAll: () => [main,jobs], addEventListener: add, removeEventListener: remove };
const window = { location: { pathname: '/dispatch', search: '?tab=jobs', hash: '' }, addEventListener: add, removeEventListener: remove, setTimeout: () => 1 };
let observer;
class Observer { constructor(fn) { this.fn = fn; observer = this; } observe() {} disconnect() {} }
const scope = { user: { uid: 'userA' }, operatingCompanyId: 'companyA', authResolved: true };
const screen = load('src/components/DashboardReturnState.tsx', {
 'react': { useLayoutEffect: fn => { layout = fn; } }, 'next/navigation': { usePathname: () => '/dispatch' }, '@/contexts/AuthContext': { useAuth: () => scope }, '@/lib/dashboardReturnState': core,
}, { document, window, location: window.location, MutationObserver: Observer, requestAnimationFrame: fn => { frames.set(++frameId,fn); return frameId; }, cancelAnimationFrame: id => frames.delete(id), clearTimeout: () => {} });
const scrollKey = core.returnKey('userA','companyA','scroll:/dispatch');
stored.set(scrollKey, JSON.stringify({ href: '/dispatch?tab=jobs', offsets: { dispatch: { x:0,y:900 }, 'dispatch-jobs':{x:0,y:400} } }));
screen.DashboardReturnState(); const cleanup = layout();
function tick() { const work = [...frames.values()]; frames.clear(); work.forEach(fn => fn()); }
tick(); assert.equal(main.scrollTop,0); assert.equal(JSON.parse(stored.get(scrollKey)).offsets.dispatch.y,900,'loading content must not overwrite the saved offset');
main.scrollHeight = 2000; jobs.scrollHeight = 1200; observer.fn(); tick();
assert.equal(main.scrollTop,900); assert.equal(jobs.scrollTop,400);
emit('pointerdown'); jobs.scrollTop = 700; emit('scroll'); tick();
assert.equal(JSON.parse(stored.get(scrollKey)).offsets['dispatch-jobs'].y,700);
cleanup(); main.scrollTop = 0; tick(); assert.equal(main.scrollTop,0,'cleanup cancels restoration after leaving');
window.location.search = '?tab=completed'; screen.DashboardReturnState(); const explicitCleanup = layout(); tick();
assert.equal(main.scrollTop,0,'an explicit different tab query must not inherit old scroll'); explicitCleanup();

let state, ref, effect;
const hooks = { useState: initial => { if (!state) state = initial(); return [state, next => { state = typeof next === 'function' ? next(state) : next; }]; },
 useRef: value => ref || (ref = { current: value }), useEffect: fn => { effect = fn; }, useCallback: fn => fn };
const view = load('src/lib/useDashboardViewState.ts', { react: hooks, 'next/navigation': { usePathname: () => '/mobile' }, '@/contexts/AuthContext': { useAuth: () => scope }, './dashboardReturnState': core });
let [value, set] = view.useDashboardViewState('mode','cards',['cards','table']); effect(); set('table');
assert.equal(view.useDashboardViewState('mode','cards',['cards','table'])[0], 'table');
const oldSetter = set; scope.operatingCompanyId = 'companyB';
assert.equal(view.useDashboardViewState('mode','cards',['cards','table'])[0], 'cards'); effect(); oldSetter('table');
assert.equal(view.useDashboardViewState('mode','cards',['cards','table'])[0], 'cards','stale callbacks cannot write into another company');
scope.operatingCompanyId = 'companyA'; assert.equal(view.useDashboardViewState('mode','cards',['cards','table'])[0], 'table');
scope.user = { uid: 'userB' }; assert.equal(view.useDashboardViewState('mode','cards',['cards','table'])[0], 'cards');
console.log('Dashboard return state: scoped URLs, redirect rejection, delayed layout, separate panes, user override and cleanup passed.');
