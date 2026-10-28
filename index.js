process.loadEnvFile('.env');
const { default: app } = await import('./src/app.js');

const port = process.env.PORT;

app.listen(port, () => {
    console.log(`App listening on port ${port}`);
});
