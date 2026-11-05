// npm run setup — asks for your admin username + password and writes .env
const fs = require('fs'), path = require('path'), crypto = require('crypto'), readline = require('readline');
const file = path.join(__dirname, '..', '.env');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
const lines = [], waiting = [];
rl.on('line', l => (waiting.length ? waiting.shift()(l) : lines.push(l)));
rl.on('close', () => waiting.forEach(w => w('')));
const ask = q => { process.stdout.write(q); return new Promise(r => (lines.length ? r(lines.shift()) : waiting.push(r))).then(a => a.trim()); };

(async () => {
  console.log('\nSignal Classroom — admin setup\n');
  if (fs.existsSync(file)) {
    const a = (await ask('.env already exists. Replace the admin login in it? (y/N) ')).toLowerCase();
    if (a !== 'y') { console.log('\nLeft untouched.\n'); return rl.close(); }
  }
  const user = (await ask('Admin username [sol]: ')) || 'sol';
  let pass = await ask('Admin password (press Enter to generate a strong one): ');
  const generated = !pass;
  if (generated) pass = crypto.randomBytes(12).toString('base64url');
  if (pass.length < 8) { console.log('\nPassword must be at least 8 characters. Run again.\n'); return rl.close(); }

  // keep any other settings (PORT, TURN_*, DATA_DIR) from the old file
  let rest = '';
  if (fs.existsSync(file)) rest = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim() && !/^\s*(ADMIN_USER|ADMIN_PASSWORD|ADMIN_KEY)\s*=/.test(l)).join('\n');
  else rest = 'PORT=3000\nDATA_DIR=./data\n\n# Optional TURN relay for hard networks:\n# TURN_URL=turn:your.turn.host:3478\n# TURN_USER=username\n# TURN_PASS=password';
  fs.writeFileSync(file, `ADMIN_USER=${user}\nADMIN_PASSWORD=${pass}\n${rest}\n`);

  console.log('\n✔ Saved to .env');
  console.log('\n  Username: ' + user + '\n  Password: ' + pass + (generated ? '   (generated — save it in a password manager)' : ''));
  console.log('\n  Next: npm start, then open http://localhost:3000/admin (type the address; it is not linked on the site)\n');
  rl.close();
})();
