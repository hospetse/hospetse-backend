// Em produção (Railway) as variáveis vêm do ambiente e não existe .env
try {
    process.loadEnvFile('.env');
} catch {
    // sem .env: segue com as variáveis do ambiente
}
const { default: app } = await import('./src/app.js');
const { attachChat } = await import('./src/conversations/chat-socket.js');

const port = process.env.PORT;

const server = app.listen(port, () => {
    console.log(`App listening on port ${port}`);
});
// Chat em tempo real (#551): na mesma porta, pelo "Upgrade: websocket" em /ws
attachChat(server);
