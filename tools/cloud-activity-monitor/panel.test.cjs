const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
test('History keeps its owner page and floating panel; repeated clicks reuse one frame',()=>{
 const elements=new Map();let srcWrites=0,focus=0;
 const el=id=>{if(!elements.has(id))elements.set(id,{hidden:true,style:{setProperty(){}},append(){},textContent:''});return elements.get(id);};
 Object.defineProperty(el('historyView'),'src',{get(){return this.value||'';},set(value){srcWrites++;this.value=value;}});
 const panel=el('panel');panel.parentNode={name:'existing floating document'};const parent=panel.parentNode;
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'panel.js'),'utf8'),{document:{getElementById:el},window:{documentPictureInPicture:{},focus(){focus++;},open(){throw Error('Must not open another tab');}},location:{origin:'http://127.0.0.1:8793'},fetch:()=>new Promise(()=>{}),setInterval(){},setTimeout(){},console});
 el('historyButton').onclick();el('historyButton').onclick();
 assert.equal(srcWrites,1);assert.equal(focus,2);assert.equal(el('historyHost').hidden,false);assert.equal(panel.parentNode,parent);
 el('closeHistory').onclick();assert.equal(el('historyHost').hidden,true);assert.equal(panel.parentNode,parent);
});
