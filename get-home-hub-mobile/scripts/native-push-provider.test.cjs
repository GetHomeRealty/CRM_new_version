/* global __dirname */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),React=require('react');
const {JSDOM}=require('jsdom'),{createRoot}=require('react-dom/client');
test('Push provider scopes foreground banners and open feeds to the current session; teardown removes native handlers',async()=>{
 const dom=new JSDOM('<div id="root"></div>');const previous={window:global.window,document:global.document};global.window=dom.window;global.document=dom.window.document;global.IS_REACT_ACT_ENVIRONMENT=true;
 let auth={token:'LOCAL_QA_session_a',user:{id:1}},handler,responseListener,imports=0,removed=0,cleared=0;const timers=new Set(),PushContext=React.createContext(null);
 const sdk={setNotificationHandler:h=>{handler=h;},getLastNotificationResponse:()=>null,addNotificationResponseReceivedListener:l=>{responseListener=l;return{remove:()=>removed++};},clearLastNotificationResponseAsync:async()=>{cleared++;},dismissAllNotificationsAsync:async()=>{},getPermissionsAsync:async()=>{throw Error('No implicit permission call allowed');}};
 const cache={};function load(name){if(cache[name])return cache[name];const file=path.join(__dirname,'../src',name),api={};cache[name]=api;vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,{exports:api,AbortController,setTimeout,clearTimeout,setInterval:fn=>{timers.add(fn);return fn;},clearInterval:fn=>timers.delete(fn),require:id=>{
 if(id==='react'||id==='react/jsx-runtime')return require(id);if(id==='react-native')return{Platform:{OS:'ios'},AppState:{currentState:'active',addEventListener:()=>({remove:()=>removed++})}};
 if(id.includes('auth-context'))return{useMobileAuth:()=>auth};if(id.includes('environment'))return{environment:{nativePushEnabled:true,pushProjectId:'00000000-0000-4000-8000-000000000001'}};
 if(id.includes('native-push-context'))return{NativePushContext:PushContext};if(id.includes('native-push-session'))return load('notifications/native-push-session.ts');
 if(id.includes('native-push-api'))return{nativePushRequest:async()=>({enabled:true,registered:false}),isCurrentPush:(data,userId)=>data?.kind==='hub-update'&&data.userId===userId};
 if(id==='expo-notifications'){imports++;return sdk;}if(id.includes('notifications-sheet'))return{NotificationsSheet:()=>React.createElement('div',null,'Current notification feed')};throw Error(id);
 }});return api;}
 const {NativePushProvider}=load('components/native-push-provider.tsx'),root=createRoot(document.getElementById('root'));
 try{
  const render=()=>root.render(React.createElement(NativePushProvider,null,React.createElement('div',null,'Home')));
  await React.act(async()=>{render();});assert.equal(imports,1);assert.equal(timers.size,1);
  const payload=userId=>({request:{content:{data:{kind:'hub-update',userId}}}});
  assert.deepEqual(JSON.parse(JSON.stringify(await handler.handleNotification(payload(1)))),{shouldShowBanner:true,shouldShowList:true,shouldPlaySound:false,shouldSetBadge:false});
  assert.equal((await handler.handleNotification(payload(2))).shouldShowBanner,false);
  const oldListener=responseListener;
  await React.act(async()=>{responseListener({notification:payload(1)});});assert.match(document.body.textContent,/Current notification feed/);
  auth={token:'LOCAL_QA_session_b',user:{id:2}};await React.act(async()=>{render();});assert.doesNotMatch(document.body.textContent,/Current notification feed/);
  await React.act(async()=>{oldListener({notification:payload(1)});});assert.doesNotMatch(document.body.textContent,/Current notification feed/);
  assert.equal((await handler.handleNotification(payload(1))).shouldShowList,false);assert.equal((await handler.handleNotification(payload(2))).shouldShowBanner,true);
  await React.act(async()=>{root.unmount();});assert.equal(handler,null);assert.equal(timers.size,0);assert(removed>=4);assert(cleared>=1);
 }finally{if(document.getElementById('root')?.textContent)await React.act(async()=>root.unmount());dom.window.close();global.window=previous.window;global.document=previous.document;delete global.IS_REACT_ACT_ENVIRONMENT;}
});
