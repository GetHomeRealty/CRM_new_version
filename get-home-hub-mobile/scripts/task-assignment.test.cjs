/* global __dirname */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),React=require('react'),{JSDOM}=require('jsdom'),{createRoot}=require('react-dom/client'),{QueryClient,QueryClientProvider}=require('@tanstack/react-query');
function load(file,req,extra={}){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/'+file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:req,AbortController,...extra});return exports;}
function api(fetch){return load('leads/task-assignment-api.ts',()=>({environment:{apiUrl:'http://localhost:8000'}}),{fetch});}
test('Task assignment is a partial PUT from allowed choices; unknown assignee rejected before network',async()=>{const calls=[],a=api(async(url,o)=>{calls.push({url,o});return {ok:true,json:async()=>({id:4,assigned_to:JSON.parse(o.body).assigned_to})};}),signal=new AbortController().signal;await a.assignLeadTask('qa',2,4,7,[{id:7}],signal);await a.assignLeadTask('qa',2,4,null,[],signal);assert.equal(calls[0].url,'http://localhost:8000/api/leads/2/tasks/4');assert.deepEqual(JSON.parse(calls[0].o.body),{assigned_to:7});assert.equal(calls[0].o.method,'PUT');await assert.rejects(a.assignLeadTask('qa',2,4,999,[{id:7}],signal),/available/);assert.equal(calls.length,2);});
test('Task assignment denial, mismatched acknowledgement and response loss never retry',async()=>{const signal=new AbortController().signal;for(const response of [{ok:false,status:403},{ok:true,json:async()=>({id:4,assigned_to:999})}])await assert.rejects(api(async()=>response).assignLeadTask('qa',2,4,7,[{id:7}],signal));let n=0;await assert.rejects(api(async()=>{n++;throw Error('lost');}).assignLeadTask('qa',2,4,7,[{id:7}],signal));assert.equal(n,1);});
function setup(kind = 'messages') {
 const dom = new JSDOM('<div id="root"></div>'), previous = { window: global.window, document: global.document }; global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
 const state = { user: { id: 1, modules: ['crm'], permissions: { lead: 'edit' } }, writes: [], fail: false, alert: null }, primitive = ({ children }) => React.createElement('div', null, children);
 const component = load('components/lead-task-assignment.tsx', id => {
  if (id === 'react' || id === 'react/jsx-runtime' || id === '@tanstack/react-query') return require(id);
  if (id === 'react-native') return { View: primitive, ActivityIndicator: primitive, Alert: { alert: (title, message, buttons) => { state.alert = { title, message, buttons }; } }, Pressable: ({ children, onPress, disabled, accessibilityLabel }) => React.createElement('button', { 'aria-label': accessibilityLabel, disabled, onClick: onPress }, children), TextInput: ({ accessibilityLabel, value, onChangeText, editable }) => React.createElement('button', { 'aria-label': accessibilityLabel, disabled: editable === false, onClick: () => onChangeText(accessibilityLabel === 'SMS record text' ? 'LOCAL QA SMS' : '2026-10-08T12:00:00Z') }, value) };
  if (id.includes('auth-context')) return { useMobileAuth: () => ({ user: state.user, token: 'synthetic' }) };
  if (id.includes('access-policy')) return load('auth/access-policy.ts');
  if (id.includes('use-theme')) return { useTheme: () => ({}) };
  if (id.includes('themed-text')) return { ThemedText: primitive };
  if(id.includes('task-assignment-api'))return {assignLeadTask:async(...args)=>{state.writes.push(args);if(state.fail)throw Error('Unconfirmed task assignment');}};
  if(id.includes('leads-api'))return {fetchLeadOptions:async()=>({users:[{id:7,name:'QA assignee',role:'agent'}]})};
  throw Error(id);
 }).LeadTaskAssignment;
 const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }), root = createRoot(document.getElementById('root'));
 const settle = () => React.act(async () => { await new Promise(r => setTimeout(r, 10)); });
 const render = async () => { await React.act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(component, { leadId:2,task:{id:4,title:'QA task',assigned_to:null} })))); await settle(); };
 const click = async label => { const b = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label); assert(b, label); assert(!b.disabled, label); await React.act(async () => b.click()); await settle(); };
 return { state, render, click, settle, cleanup: async () => { await React.act(async () => root.unmount()); client.clear(); dom.window.close(); Object.assign(global, previous); delete global.IS_REACT_ACT_ENVIRONMENT; } };
}


test('Task choice requires confirmation; cancellation/revoked grant makes no write',async()=>{const h=setup();try{await h.render();await h.click('Assign task 4 QA assignee');assert.equal(h.state.writes.length,0);const confirm=h.state.alert.buttons.find(b=>b.text==='Confirm task assignment');h.state.user.permissions={lead:'view'};await h.render();await React.act(async()=>confirm.onPress());await h.settle();assert.equal(h.state.writes.length,0);assert(!document.body.textContent.includes('Search task assignees'));}finally{await h.cleanup();}});
test('Acknowledged task assignment submits exact target; uncertain response locks repeat actions',async()=>{for(const fail of [false,true]){const h=setup();try{await h.render();h.state.fail=fail;await h.click('Assign task 4 QA assignee');await React.act(async()=>h.state.alert.buttons.find(b=>b.text==='Confirm task assignment').onPress());await h.settle();assert.equal(h.state.writes.length,1);assert.equal(h.state.writes[0][3],7);if(fail){assert.match(document.body.textContent,/Unconfirmed/);assert([...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Assign task 4 QA assignee').disabled);}}finally{await h.cleanup();}}});
