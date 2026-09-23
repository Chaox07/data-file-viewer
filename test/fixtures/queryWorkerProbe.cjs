// Synthetic availability probe: no database, file or network access.
process.on('message', message => {
  if (message.method === 'echo') process.send({ id: message.id, value: message.args[0] });
  if (message.method === 'exit') process.exit(1);
  if (message.method === 'stall') { for (;;) {} }
  if (message.method === 'delayedEcho') setTimeout(() => process.send({ id: message.id, value: message.args[0] }), 100);
  if (message.method === 'hasSecret') process.send({ id: message.id, value: Object.hasOwn(process.env, 'DFV_SYNTHETIC_SECRET') });
  if (message.method === 'cwd') process.send({ id: message.id, value: process.cwd() });
});
