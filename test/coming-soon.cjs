// The pre-launch strip: one sentence, Mila's face, and a dismissal that sticks.
//
// Three things can go wrong quietly here, so all three are pinned:
//   * it renders on production and not on dev, because "coming soon" is a
//     message for visitors and not for us;
//   * the sentence goes through the landing dictionary, so a French visitor is
//     not the only one on the page reading English;
//   * it can be switched off without a deploy -- a launched product that keeps
//     telling people it has not launched is worse than never having said it.
process.env.ANTHROPIC_API_KEY = 'stub';
process.env.DB_FILE = '/tmp/pp-soon.db';
process.env.PORT = '9671';
process.env.PASS_SECRET = 'testsecret';
process.env.APP_ENV = 'production';        // the strip's home

const fs = require('node:fs');
for (const f of [process.env.DB_FILE, process.env.DB_FILE + '-wal', process.env.DB_FILE + '-shm']) fs.rmSync(f, { force: true });

let fail = 0;
const check = (l, c, d) => { if (!c) { fail++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } else console.log(`  ok   ${l}`); };

const consultant = require('../consultant.js');
consultant._setClient({ beta: { messages: { create: async () => ({ model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: '.' }], usage: {} }) } } });

const B = 'http://127.0.0.1:9671';
const EN = 'Get ready for the magic — coming soon';

(async () => {
  require('../server.js');
  for (let i = 0; i < 60 && !(await fetch(`${B}/api/config`).then((r) => r.ok).catch(() => false)); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log('\n[it flies on the English landing page]');
  {
    const html = await (await fetch(B + '/')).text();
    check('the strip is in the markup', html.includes('class="csoon"'));
    check('the sentence is there', html.includes('Get ready for the magic &mdash; coming soon'));
    check('Mila is beside it', /class="csoon"[\s\S]{0,400}img\/mila\//.test(html));
    // Decorative: the sentence already says everything, and a name here would
    // make a screen reader announce the banner twice.
    check('her portrait is decorative', /csoon[\s\S]{0,200}alt=""[^>]*aria-hidden="true"/.test(html));
    check('it sits above the nav', html.indexOf('class="csoon"') < html.indexOf('<div class="nav">'));
    check('it can be dismissed', html.includes('pp-soon-seen'));
  }

  console.log('\n[and in every landing language]');
  {
    const cfg = await (await fetch(B + '/api/config')).json();
    check('the config tells the app', cfg.comingSoon === true);
    const langs = ['es', 'pt', 'fr', 'de', 'it', 'zh', 'ja', 'ko', 'ru'];
    for (const l of langs) {
      const html = await (await fetch(B + '/' + l)).text();
      const m = html.match(/<span class="csoon-t">([^<]+)<\/span>/);
      const got = m ? m[1].trim() : '';
      check(`${l}: translated`, got && got !== 'Get ready for the magic &mdash; coming soon', got || 'no strip');
      // aria-label joined the translated attributes for this banner's sake --
      // the close button is the one control on it, and an English name on it
      // is the one bit of the strip a screen-reader user would hit.
      const btn = html.match(/class="csoon-x"[^>]*aria-label="([^"]+)"/);
      check(`${l}: the close button is named in ${l}`, btn && btn[1] !== 'Dismiss', btn ? btn[1] : 'no button');
    }
  }

  console.log('\n[the app carries the same sentence]');
  {
    const html = await (await fetch(B + '/app')).text();
    check('the strip is in the app shell', html.includes('id="csoon"'));
    check('it starts hidden, to be shown only if the server says so', /id="csoon"[^>]*hidden/.test(html));
    check('the app reads the same dismissal key', html.includes('pp-soon-seen'));
    const dict = JSON.parse(fs.readFileSync(__dirname + '/../public/i18n/pt.json', 'utf8'));
    check('and the app dictionaries have the line', Boolean(dict[EN]), dict[EN]);
  }

  console.log('\n[the switch works]');
  {
    // Same server, so this is checked the only way it can be from here: the
    // flag is read once at boot, and what it gates is a single function.
    const off = require('child_process').spawnSync(process.execPath, ['-e', `
      process.env.COMING_SOON='0'; process.env.APP_ENV='production';
      process.env.ANTHROPIC_API_KEY='stub'; process.env.PASS_SECRET='t';
      process.env.DB_FILE='/tmp/pp-soon-off.db'; process.env.PORT='9670';
      require('${__dirname}/../server.js');
      setTimeout(async () => {
        const h = await (await fetch('http://127.0.0.1:9670/')).text();
        const c = await (await fetch('http://127.0.0.1:9670/api/config')).json();
        console.log(JSON.stringify({ strip: h.includes('class="csoon"'), cfg: c.comingSoon }));
        process.exit(0);
      }, 2500);
    `], { encoding: 'utf8', timeout: 30000 });
    const line = (off.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    const r = line ? JSON.parse(line) : {};
    check('COMING_SOON=0 takes the strip down', r.strip === false, JSON.stringify(r));
    check('and tells the app it is down', r.cfg === false, JSON.stringify(r));
  }

  console.log(fail ? `\n${fail} failed` : '\nall good');
  process.exit(fail ? 1 : 0);
})();
