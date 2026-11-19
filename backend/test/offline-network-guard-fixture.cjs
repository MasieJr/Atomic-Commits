const operations = [
  () => require('node:net').connect(1, '127.0.0.1'),
  () => require('node:http').request('http://127.0.0.1'),
  () => require('node:https').request('https://127.0.0.1'),
  () => require('node:tls').connect(1, '127.0.0.1'),
  () => require('node:dns').lookup('localhost', () => {}),
  () => require('node:dgram').createSocket('udp4'),
  () => require('node:child_process').spawn('node', ['-v']),
  () => require('node:child_process').execSync('node -v'),
  () => require('node:dns').promises.resolve4('localhost'),
];
for (const operation of operations) {
  try {
    operation();
    process.exit(2);
  } catch (error) {
    if (!String(error.message).includes('networking is disabled')) process.exit(3);
  }
}
fetch('https://127.0.0.1').then(() => process.exit(4), () => process.stdout.write('blocked'));
