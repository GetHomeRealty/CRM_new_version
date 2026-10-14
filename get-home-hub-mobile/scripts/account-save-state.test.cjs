/* global __dirname */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),ts=require('typescript'),React=require('react');const {JSDOM}=require('jsdom'),{createRoot}=require('react-dom/client');
test('Confirmed profile/preferences saves clear only their own unsaved edits; failed saves retain drafts',async()=>{
 const dom=new JSDOM('<div id="root"></div>'),old={window:global.window,document:global.document};global.window=dom.window;global.document=dom.window.document;global.IS_REACT_ACT_ENVIRONMENT=true;
 let profile={name:'LOCAL QA',username:'',phone:'',email:'qa@example.invalid',role:'agent',status:'Active'},closed=0,alert,fail=false;const prefs={signature:'',replyTemplate:'',forwardingAddress:'',autoSync:false,autoResponder:{enabled:false,message:''}},api={};
 const primitive=({children})=>React.createElement('div',null,children);
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/components/account-settings-sheet.tsx'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports:api,Error,AbortController,setTimeout,clearTimeout,require:id=>{
 if(id==='react'||id==='react/jsx-runtime')return require(id);
 if(id==='react-native')return{View:primitive,Modal:primitive,ScrollView:primitive,ActivityIndicator:primitive,Switch:primitive,Alert:{alert:(title,_message,buttons)=>{alert={title,buttons};}},Pressable:({children,onPress,disabled})=>React.createElement('button',{onClick:onPress,disabled},children),TextInput:({accessibilityLabel,onChangeText})=>React.createElement('button',{onClick:()=>onChangeText(accessibilityLabel==='Phone'?'+14165550100':'LOCAL QA unsaved signature')},'Edit '+accessibilityLabel)};
 if(id.includes('safe-area'))return{SafeAreaProvider:primitive,SafeAreaView:primitive};if(id.includes('auth-context'))return{useMobileAuth:()=>({token:'LOCAL_QA_token'})};if(id.includes('use-theme'))return{useTheme:()=>({})};if(id.includes('themed-text'))return{ThemedText:primitive};if(id.includes('mailbox-editor'))return{MailboxEditor:primitive};if(id.includes('connect-mailbox-sheet'))return{ConnectMailboxSheet:primitive};if(id.includes('security-settings-sheet'))return{SecuritySettingsSheet:primitive};
 if(id.includes('account-api'))return{profileInput:x=>x,preferencesInput:x=>x,mailboxInput:x=>x,accountRequest:async(_token,p,method='GET',body)=>{if(method!=='GET'){if(fail)throw Error('Result not confirmed');if(p==='profile'){profile={...profile,...body};return profile;}return{};}return p==='profile'?profile:p==='settings'?{emailSettings:prefs}:[];}};throw Error(id);
 }});
 const root=createRoot(document.getElementById('root'));const click=async label=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent===label);assert(button,label);await React.act(async()=>button.click());};
 try{
 await React.act(async()=>root.render(React.createElement(api.AccountSettingsSheet,{onClose:()=>closed++})));
 await click('Edit Phone');await click('Save profile');await click('Close settings');assert.equal(closed,1);assert.equal(alert,undefined);
 await click('Edit Email signature');await click('Edit Phone');await click('Save profile');await click('Close settings');assert.equal(closed,1);assert.equal(alert.title,'Discard unsaved changes?');
 await click('Save email preferences');assert.equal(alert.title,'Save email preferences?');await React.act(async()=>alert.buttons.find(b=>b.text==='Save').onPress());alert=undefined;await click('Close settings');assert.equal(closed,2);assert.equal(alert,undefined);
 fail=true;await click('Edit Phone');await click('Save profile');assert.match(document.body.textContent,/Result not confirmed/);await click('Close settings');assert.equal(alert.title,'Discard unsaved changes?');assert.equal(closed,2);
 }finally{await React.act(async()=>root.unmount());dom.window.close();Object.assign(global,old);delete global.IS_REACT_ACT_ENVIRONMENT;}
});
