import WebSocket from 'ws';
const [url, code] = process.argv.slice(2);
const ws = new WebSocket(url + '/ws?code=' + code);
const t = setTimeout(()=>{ console.log('TIMEOUT'); process.exit(1); }, 20000);
ws.on('open', ()=>{ console.log('✓ сокет открыт'); ws.send(JSON.stringify({type:'join', code, name:'Аня', sessionId:'cf-a'})); });
ws.on('message', m=>{ const d=JSON.parse(m);
  if(d.type==='joined'){ console.log('✓ joined: комната', d.code, 'партия', d.part);
    ws.send(JSON.stringify({type:'time', t0:Date.now()})); }
  if(d.type==='time'){ console.log('✓ часы: RTT', d.t1-d.t0, 'мс'); clearTimeout(t); process.exit(0); }
  if(d.type==='error'){ console.log('✗', d.code, d.message); process.exit(1); }
});
ws.on('error', e=>{ console.log('WS ERR', e.message); process.exit(1); });
