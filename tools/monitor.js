// Регистрирует UptimeRobot-монитор на деплой RHYME TOGETHER.
// Запуск: UPTIME_KEY=... node tools/monitor.js https://rhyme-together.onrender.com
const key = process.env.UPTIME_KEY;
const url = process.argv[2];
if (!key || !url) { console.error('нужны UPTIME_KEY и URL'); process.exit(1); }

const post = (path, body) => fetch('https://api.uptimerobot.com/v2/' + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
  body: JSON.stringify({ api_key: key, format: 'json', ...body }),
}).then(r => r.json());

const main = async () => {
  const list = await post('getMonitors', {});
  const exists = (list.monitors || []).find(m => m.url === url + '/api/health');
  if (exists) { console.log('монитор уже есть:', exists.id); return; }

  const created = await post('newMonitor', {
    friendly_name: 'RHYME TOGETHER — игровой сервер',
    url: url + '/api/health',
    type: 1,            // HTTP(s)
    interval: 300,      // каждые 5 минут — free-инстанс Render не засыпает
    timeout: 30,
    alert_contacts: '',
  });
  if (created.stat !== 'ok') { console.error('ошибка:', JSON.stringify(created)); process.exit(1); }
  const id = created.monitor.id;
  console.log('монитор создан:', id);

  // keyword-проверка: сервер должен отвечать {"ok":true}
  await post('editMonitor', { id, type: 2, keyword_type: 2, keyword_value: '"ok":true', keyword_case_type: 0 });
  console.log('включена проверка ключевого слова "ok":true');
};
main();
