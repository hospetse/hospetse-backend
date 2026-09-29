import express from 'express';
const app = express();
const port = 3000;

app.get('/', (req, res) => {
    res.send('Hello World');
});

app.get('/health', (req, res)=>{
    res.status(200).json(
        { status: "Server is running"});
})

app.listen(port, () => {
    console.log(`App listening on port ${port}`);
});