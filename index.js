import app from './app.js';

process.loadEnvFile('.env');
const port = process.env.PORT;

app.listen(port, () => {
    console.log(`App listening on port ${port}`);
});