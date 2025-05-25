// server.js
const express = require('express');
const YTDlpWrap = require('yt-dlp-wrap').default; // yt-dlp-wrap ainda é usado
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const { existsSync, mkdirSync } = require('fs'); // Para algumas operações síncronas
const { v4: uuidv4 } = require('uuid');

const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');

// Configura o fluent-ffmpeg para usar o binário baixado pelo @ffmpeg-installer
// Isso é para a conversão MP3 FEITA PELO fluent-ffmpeg.
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();

// --- CONFIGURAÇÃO DO CAMINHO PARA O BINÁRIO yt-dlp EMPACOTADO ---
const ytDlpBinaryPath = path.join(__dirname, 'bin', 'yt-dlp');

// Verificação e log para o ambiente Vercel
if (process.env.VERCEL === '1') {
    console.log(`Verificando binário yt-dlp empacotado em: ${ytDlpBinaryPath}`);
    if (existsSync(ytDlpBinaryPath)) {
        console.log(`Binário yt-dlp encontrado em ${ytDlpBinaryPath}. Certifique-se de que ele tem permissões de execução via Git.`);
        // Nota: chmodSync em /var/task (onde o código reside na Vercel) geralmente não funciona por ser read-only.
        // A permissão deve ser definida ANTES do deploy, via Git.
    } else {
        // Este é um erro crítico se o binário não for encontrado.
        console.error(`ERRO FATAL: Binário yt-dlp NÃO encontrado em ${ytDlpBinaryPath}. O download de informações e vídeos falhará.`);
    }
}

// Instancia YTDlpWrap com o caminho para o binário local empacotado
// Este ytDlpWrap será usado para obter metadados e para o download de MP4 (que usa yt-dlp diretamente)
const ytDlpWrap = new YTDlpWrap(ytDlpBinaryPath);
// --- FIM DA CONFIGURAÇÃO DO yt-dlp ---


// Diretório temporário - ajustado para Vercel e local
const IS_VERCEL = process.env.VERCEL === '1';
const TEMP_DOWNLOAD_DIR_BASE = IS_VERCEL ? '/tmp' : __dirname;
const TEMP_DOWNLOAD_DIR = path.join(TEMP_DOWNLOAD_DIR_BASE, 'temp_downloads');

if (!existsSync(TEMP_DOWNLOAD_DIR)) {
    mkdirSync(TEMP_DOWNLOAD_DIR, { recursive: true });
    console.log(`Diretório temporário criado/verificado em: ${TEMP_DOWNLOAD_DIR}`);
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'downloader.html'));
});

app.post('/get-video-info', async (req, res) => {
    const { youtubeUrl, format, quality } = req.body;

    if (!youtubeUrl) {
        return res.status(400).json({ error: 'URL do YouTube é obrigatória.' });
    }

    let downloadedAudioFilePath = null; 
    let outputPathForCurrentRequest = null; 

    try {
        const requestTimestamp = new Date().toISOString();
        console.log(`[${requestTimestamp}] Pedido recebido: URL=${youtubeUrl}, Formato=${format}, Qualidade=${quality}`);
        console.log(`Usando TEMP_DOWNLOAD_DIR: ${TEMP_DOWNLOAD_DIR}`);
        console.log(`Caminho do FFmpeg (para fluent-ffmpeg): ${ffmpegInstaller.path}`);
        console.log(`Caminho do yt-dlp (para yt-dlp-wrap): ${ytDlpBinaryPath}`);


        const metadataJson = await ytDlpWrap.getVideoInfo(youtubeUrl); // Usa o ytDlpWrap configurado
        const videoTitleBase = metadataJson.title ? metadataJson.title.replace(/[^\w\s.-]/gi, '_') : 'media';

        if (format === 'mp3') {
            const uniqueIdInput = uuidv4();
            const uniqueIdOutput = uuidv4();
            
            const bestAudioFormatDetails = metadataJson.formats
                .filter(f => f.vcodec === 'none' && f.acodec !== 'none')
                .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

            if (!bestAudioFormatDetails) {
                throw new Error('Nenhum formato de áudio adequado encontrado para download inicial (MP3).');
            }
            
            const inputAudioExtension = bestAudioFormatDetails.ext || 'm4a';
            const downloadedAudioFileName = `${videoTitleBase}_input_${uniqueIdInput}.${inputAudioExtension}`;
            downloadedAudioFilePath = path.join(TEMP_DOWNLOAD_DIR, downloadedAudioFileName);
            
            const finalOutputMp3Name = `${videoTitleBase}_${uniqueIdOutput}.mp3`;
            outputPathForCurrentRequest = path.join(TEMP_DOWNLOAD_DIR, finalOutputMp3Name);

            console.log(`Baixando melhor áudio para (MP3): ${downloadedAudioFilePath} (Formato: ${inputAudioExtension}, ID: ${bestAudioFormatDetails.format_id})`);
            // yt-dlp-wrap (com o binário empacotado) baixa o áudio original
            await ytDlpWrap.execPromise([
                youtubeUrl,
                '-f', bestAudioFormatDetails.format_id || 'bestaudio/best',
                '-o', downloadedAudioFilePath
            ]);
            console.log('Áudio original para MP3 baixado.');

            console.log(`Iniciando conversão de ${downloadedAudioFilePath} para ${outputPathForCurrentRequest} usando fluent-ffmpeg`);
            await new Promise((resolve, reject) => {
                ffmpeg(downloadedAudioFilePath) // fluent-ffmpeg usa o FFmpeg de @ffmpeg-installer
                    .audioCodec('libmp3lame')
                    .audioQuality(0) 
                    .toFormat('mp3')
                    .on('error', (err) => {
                        console.error(`[${requestTimestamp}] Erro do FFmpeg (MP3):`, err.message);
                        reject(new Error(`Falha na conversão para MP3: ${err.message}`));
                    })
                    .on('progress', (progress) => {
                        if (progress.percent) { console.log(`Progresso da conversão MP3: ${progress.percent.toFixed(2)}%`); }
                    })
                    .on('end', () => {
                        console.log('Conversão para MP3 finalizada com sucesso!');
                        resolve();
                    })
                    .save(outputPathForCurrentRequest);
            });
            
            console.log(`MP3 convertido salvo em: ${outputPathForCurrentRequest}`);
            const serverDownloadUrl = `/downloads/${finalOutputMp3Name}`;
            return res.json({
                success: true, message: 'MP3 pronto para download!', downloadUrl: serverDownloadUrl,
                fileName: finalOutputMp3Name, title: metadataJson.title, mimeType: 'audio/mpeg'
            });

        } else if (format === 'mp4') {
            const uniqueIdOutput = uuidv4();
            const finalOutputMp4Name = `${videoTitleBase}_${uniqueIdOutput}.mp4`;
            outputPathForCurrentRequest = path.join(TEMP_DOWNLOAD_DIR, finalOutputMp4Name);

            let formatSelector = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]';
            if (quality && quality !== 'highest') {
                const requestedHeight = parseInt(quality);
                if (!isNaN(requestedHeight)) {
                    formatSelector = `bestvideo[height<=?${requestedHeight}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=?${requestedHeight}]+bestaudio/best[height<=?${requestedHeight}][ext=mp4]/best[ext=mp4]`;
                } else {
                    console.warn(`Qualidade MP4 inválida: ${quality}. Usando seleção padrão.`);
                }
            }
            
            console.log(`Iniciando download e merge para MP4: ${outputPathForCurrentRequest} com seletor: ${formatSelector}`);
            const mp4DownloadArgs = [
                youtubeUrl,
                '-f', formatSelector,
                '--merge-output-format', 'mp4',
                '-o', outputPathForCurrentRequest
            ];

            try {
                // yt-dlp-wrap (com o binário empacotado) baixa e mescla o MP4.
                // A mesclagem usará o FFmpeg que o yt-dlp encontrar (deve ser o de @ffmpeg-installer se yt-dlp não tiver um próprio ou se não achar outro no sistema)
                await ytDlpWrap.execPromise(mp4DownloadArgs);
                console.log(`MP4 salvo com sucesso em: ${outputPathForCurrentRequest}`);

                const serverDownloadUrl = `/downloads/${finalOutputMp4Name}`;
                return res.json({
                    success: true, message: 'MP4 com áudio pronto para download!', downloadUrl: serverDownloadUrl,
                    fileName: finalOutputMp4Name, title: metadataJson.title, mimeType: 'video/mp4'
                });
            } catch (downloadError) {
                console.error(`[${requestTimestamp}] Erro durante o download/merge para MP4:`, downloadError.stderr || downloadError.message || downloadError);
                throw new Error(`Falha ao processar para MP4: ${downloadError.message || 'Erro do yt-dlp'}`);
            }
        } else {
            return res.status(400).json({ error: 'Formato inválido.' });
        }

    } catch (error) {
        const requestTimestamp = new Date().toISOString();
        console.error(`[${requestTimestamp}] Erro detalhado no servidor:`, error);
        // Se outputPathForCurrentRequest foi definido e o arquivo existe devido a uma falha parcial, limpe-o.
        if (outputPathForCurrentRequest && existsSync(outputPathForCurrentRequest)) {
            try {
                await fs.unlink(outputPathForCurrentRequest);
                console.log(`Arquivo parcial ${outputPathForCurrentRequest} deletado após erro.`);
            } catch (e) { console.error(`Erro ao deletar arquivo parcial ${outputPathForCurrentRequest}:`, e); }
        }
        res.status(500).json({ error: 'Erro ao processar o vídeo.', details: error.message });
    } finally {
        if (downloadedAudioFilePath) { 
            try { if (existsSync(downloadedAudioFilePath)) { await fs.unlink(downloadedAudioFilePath); console.log(`Arquivo de áudio intermediário ${downloadedAudioFilePath} deletado.`); }
            } catch (cleanupError) { console.error(`Erro ao deletar ${downloadedAudioFilePath}:`, cleanupError); }
        }
    }
});

app.get('/downloads/:filename', async (req, res) => {
    const { filename } = req.params;
    const filePath = path.join(TEMP_DOWNLOAD_DIR, filename);
    const requestTimestamp = new Date().toISOString();

    console.log(`[${requestTimestamp}] Tentando servir arquivo: ${filePath}`);
    try {
        if (existsSync(filePath)) {
            res.download(filePath, filename, async (err) => {
                if (err) { 
                    console.error(`[${requestTimestamp}] Erro ao enviar o arquivo ${filename} para download:`, err);
                    if (!res.headersSent) { res.status(500).send('Erro ao tentar baixar o arquivo.'); } 
                } else { 
                    console.log(`[${requestTimestamp}] Arquivo ${filename} enviado com sucesso para o cliente.`);
                    setTimeout(async () => {
                        try {
                            if (existsSync(filePath)) { await fs.unlink(filePath); console.log(`Arquivo ${filePath} deletado do servidor após download.`); }
                        } catch (e) { console.error(`Erro ao deletar arquivo ${filePath} após download:`, e); }
                    }, 5000); 
                }
            });
        } else { 
            console.warn(`[${requestTimestamp}] Arquivo não encontrado para download: ${filePath}`);
            res.status(404).send('Arquivo não encontrado ou já foi removido.'); 
        }
    } catch (error) { 
        console.error(`[${requestTimestamp}] Erro na rota /downloads:`, error);
        if (!res.headersSent) { res.status(500).send('Erro interno do servidor ao processar o download.'); } 
    }
});

if (!IS_VERCEL) {
    const port = process.env.PORT || 3000;
    app.listen(port, () => {
        console.log(`Servidor backend rodando em http://localhost:${port}`);
        console.log(`Usando fluent-ffmpeg com FFmpeg de @ffmpeg-installer: ${ffmpegInstaller.path}`);
        console.log(`Usando yt-dlp-wrap com binário yt-dlp de: ${ytDlpBinaryPath}`);
    });
}

module.exports = app;
