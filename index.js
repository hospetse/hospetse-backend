// Em produção (Railway) as variáveis vêm do ambiente e não existe .env
try {
    process.loadEnvFile('.env');
} catch {
    // sem .env: segue com as variáveis do ambiente
}
const { default: app } = await import('./src/app.js');

const port = process.env.PORT;

app.listen(port, () => {
    console.log(`App listening on port ${port}`);
});
