/* global __dirname */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
function load(file,extra={}){const api={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/'+file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:api,URLSearchParams,AbortController,require:()=>({environment:{apiUrl:'http://localhost:8000'}}),...extra});return api;}
const {formattedMail}=load('inbox/formatted-body.ts');
const joined=result=>result.blocks.map(b=>b.prefix+b.spans.map(s=>s.text).join('')).join('\n');
test('Native formatted text preserves headings, inline whitespace, lists, tables and safe Unicode entities',()=>{
 const r=formattedMail('<h2>LOCAL QA</h2><p>Hello <strong>bold</strong> and <em>italic</em> &amp; &#x1f600;.</p><ol><li>First</li><li>Second</li></ol><table><tr><th>Key</th><td>Value</td></tr></table>');
 assert.equal(r.blocks[0].heading,2);assert(r.blocks[1].spans.some(s=>s.bold&&s.text==='bold'));assert(r.blocks[1].spans.some(s=>s.italic&&s.text==='italic'));
 assert.match(joined(r),/Hello bold and italic & 😀\./);assert.match(joined(r),/1\. First\n2\. Second/);assert.match(joined(r),/Key \| Value/);assert.equal(r.truncated,false);
});
test('Executable containers, remote media and attributes never enter native output',()=>{
 const r=formattedMail('<script>SECRET_EXECUTABLE</script><style>SECRET_STYLE</style><iframe>SECRET_FRAME</iframe><svg>SECRET_SVG</svg><p onclick="SECRET_HANDLER">Safe <a href="javascript:SECRET_LINK">label</a></p><img src="https://SECRET_REMOTE.invalid"><!--SECRET_COMMENT-->');
 assert.equal(joined(r),'Safe label');assert.equal(r.mediaOmitted,true);assert(!JSON.stringify(r).includes('SECRET'));assert(r.blocks[0].spans.at(-1).underline);
});
test('Malformed, deeply nested and oversized HTML stays bounded with truncation',()=>{
 for(const input of ['<b>'.repeat(500)+'visible'+'</b>'.repeat(500),'<p>x</p>'.repeat(10000),'x'.repeat(200001),'<strong>x</strong>'.repeat(2000)]){const r=formattedMail(input);assert(r.truncated);assert(r.blocks.length<=200);assert(r.blocks.reduce((n,b)=>n+b.spans.length,0)<=800);}
 assert.equal(joined(formattedMail('literal < broken')),'literal < broken');assert.equal(joined(formattedMail('<pre>a\n  b</pre>')),'a\n  b');
});
function harness(){let body={available:true,data:[{uid:9,subject:'LOCAL QA',from:'a@example.invalid',to:'b@example.invalid',sent_at:null}],next_cursor:null,account_id:1,validity:'101'},status=200;const calls=[];const api=load('inbox/provider-sent-api.ts',{fetch:async(url,options)=>{calls.push({url:new URL(url),options});return{ok:status===200,status,json:async()=>body};}});return{api,calls,setBody:v=>body=v,setStatus:v=>status=v,body};}
test('Provider Sent GET pins area, owner mailbox, UID validity, cursor and cancellation',async()=>{
 const h=harness(),signal=new AbortController().signal;await h.api.fetchProviderSent('synthetic','desk',{account:1,validity:'101',cursor:10},signal);const c=h.calls[0];assert.equal(c.url.pathname,'/api/account/provider-sent');assert.equal(c.url.searchParams.toString(),'area=desk&account=1&cursor=10&validity=101');assert.equal(c.options.method,'GET');assert.equal(c.options.body,undefined);assert.equal(c.options.signal,signal);assert.equal(c.options.headers.Authorization,'Bearer synthetic');
});
test('Provider Sent rejects malformed/stale pages, unsafe references and unsupported detail before exposure',async()=>{
 const signal=new AbortController().signal;
 for(const patch of [{validity:'1e2'},{validity:'0101'},{validity:101},{account_id:2},{next_cursor:8},{data:[{...harness().body.data[0]},{...harness().body.data[0]}]}]){const h=harness();h.setBody({...h.body,...patch});await assert.rejects(h.api.fetchProviderSent('synthetic','crm',{account:1,validity:'101'},signal));}
 const h=harness();for(const ref of [{cursor:0},{validity:'1e2'},{account:-1}])await assert.rejects(h.api.fetchProviderSent('synthetic','crm',ref,signal));assert.equal(h.calls.length,0);
 await assert.rejects(h.api.fetchProviderSentDetail('synthetic','crm',9,{},signal));assert.equal(h.calls.length,0);
 h.setBody({...h.body.data[0],body_text:'safe',body_html:null,content_available:true,truncated:false,attachments:[]});assert.equal((await h.api.fetchProviderSentDetail('synthetic','crm',9,{account:1,validity:'101'},signal)).body_text,'safe');assert.equal(h.calls[0].url.pathname,'/api/account/provider-sent/9');
 h.setBody({...h.body.data[0],body_text:'x'.repeat(200001),body_html:null,content_available:true,truncated:false,attachments:[]});await assert.rejects(h.api.fetchProviderSentDetail('synthetic','crm',9,{account:1,validity:'101'},signal));
});
test('Provider errors and cancelled calls fail closed without exposing server text',async()=>{
 for(const status of [401,404,500]){const h=harness();h.setStatus(status);await assert.rejects(h.api.fetchProviderSent('synthetic','crm',{},new AbortController().signal),/Sign in|changed|could not/);}
 const h=harness(),c=new AbortController();c.abort();await assert.rejects(h.api.fetchProviderSent('synthetic','crm',{},c.signal));assert.equal(h.calls.length,0);
});
