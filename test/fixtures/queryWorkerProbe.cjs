// Synthetic availability probe: no database, file or network access.
process.on('message', message => {
  if (message.method === 'echo') process.send({ id: message.id, value: message.args[0] });
  if (message.method === 'exit') process.exit(1);
  if (message.method === 'stall') { for (;;) {} }
});
