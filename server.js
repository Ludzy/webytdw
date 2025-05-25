// server.js
const express = require('express');
const YTDlpWrap = require('yt-dlp-wrap').default;
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const { existsSync, mkdirSync } = require('fs');
const { v4: uuidv4 } = require('uuid');

// Fluent FFmpeg - Estas são as importações corretas para esta abordagem
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');

// Configura o fluent-ffmpeg para usar o binário baixado pelo @ffmpeg-installer
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
const port = 3000;

const ytDlpWrap = new YTDlpWrap();

const TEMP_DOWNLOAD_DIR = path.join(__dirname, 'temp_downloads');
if (!existsSync(TEMP_DOWNLOAD_DIR)) {
    mkdirSync(TEMP_DOWNLOAD_DIR, { recursive: true });
    console.log(`Diretório temporário criado em: ${TEMP_DOWNLOAD_DIR}`);
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
    let finalOutputMp3Path = null;    

    try {
        console.log(`Pedido recebido: URL=${youtubeUrl}, Formato=${format}, Qualidade=${quality}`);
        const metadataJson = await ytDlpWrap.getVideoInfo(youtubeUrl);
        const videoTitleBase = metadataJson.title ? metadataJson.title.replace(/[^\w\s.-]/gi, '_') : 'media';

        if (format === 'mp3') {
            const uniqueIdInput = uuidv4();
            const bestAudioFormatDetails = metadataJson.formats
                .filter(f => f.vcodec === 'none' && f.acodec !== 'none')
                .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

            if (!bestAudioFormatDetails) {
                throw new Error('Nenhum formato de áudio adequado encontrado para download inicial.');
            }
            
            const inputAudioExtension = bestAudioFormatDetails.ext || 'm4a';
            const downloadedAudioFileName = `${videoTitleBase}_input_${uniqueIdInput}.${inputAudioExtension}`;
            downloadedAudioFilePath = path.join(TEMP_DOWNLOAD_DIR, downloadedAudioFileName);

            console.log(`Baixando melhor áudio para: ${downloadedAudioFilePath} (Formato: ${inputAudioExtension}, ID: ${bestAudioFormatDetails.format_id})`);
            await ytDlpWrap.execPromise([
                youtubeUrl,
                '-f', bestAudioFormatDetails.format_id || 'bestaudio/best',
                '-o', downloadedAudioFilePath
            ]);
            console.log('Áudio original baixado.');

            const uniqueIdOutput = uuidv4();
            const finalOutputMp3Name = `${videoTitleBase}_${uniqueIdOutput}.mp3`;
            finalOutputMp3Path = path.join(TEMP_DOWNLOAD_DIR, finalOutputMp3Name);

            console.log(`Iniciando conversão de ${downloadedAudioFilePath} para ${finalOutputMp3Path}`);

            await new Promise((resolve, reject) => {
                ffmpeg(downloadedAudioFilePath)
                    .audioCodec('libmp3lame')
                    .audioQuality(0) // Equivalente a -q:a 0 (melhor VBR)
                    .toFormat('mp3')
                    .on('error', (err) => {
                        console.error('Erro do FFmpeg:', err.message);
                        reject(new Error(`Falha na conversão para MP3: ${err.message}`));
                    })
                    .on('progress', (progress) => {
                        if (progress.percent) {
                            console.log(`Progresso da conversão: ${progress.percent.toFixed(2)}%`);
                        } else if (progress.timemark) {
                            console.log(`Progresso da conversão (timemark): ${progress.timemark}`);
                        }
                    })
                    .on('end', () => {
                        console.log('Conversão para MP3 finalizada com sucesso!');
                        resolve();
                    })
                    .save(finalOutputMp3Path);
            });
            
            console.log(`MP3 convertido salvo em: ${finalOutputMp3Path}`);
            const serverDownloadUrl = `/downloads/${finalOutputMp3Name}`;
            return res.json({
                success: true,
                message: 'MP3 pronto para download!',
                downloadUrl: serverDownloadUrl,
                fileName: finalOutputMp3Name,
                title: metadataJson.title,
                mimeType: 'audio/mpeg'
            });

        } else if (format === 'mp4') {
            let formatSelector = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]';
            if (quality && quality !== 'highest') {
                const requestedHeight = parseInt(quality);
                formatSelector = `bestvideo[height<=?${requestedHeight}][ext=mp4]+bestaudio[ext=m4a]/best[height<=?${requestedHeight}][ext=mp4]`;
            }
            const downloadArgs = [youtubeUrl, '-f', formatSelector, '-g'];
            let directLinkResult = await ytDlpWrap.execPromise(downloadArgs);
            let directLink = directLinkResult.split('\n')[0].trim();
            
            if (!directLink || !directLink.startsWith('http')) {
                const mp4Format = metadataJson.formats?.find(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.ext === 'mp4' && (quality === 'highest' || (f.height && f.height <= parseInt(quality))));
                if (mp4Format) directLink = mp4Format.url;
                else { const bestMp4Overall = metadataJson.formats?.filter(f => f.ext === 'mp4' && f.vcodec !== 'none').sort((a,b) => (b.height || 0) - (a.height || 0))[0]; if (bestMp4Overall) directLink = bestMp4Overall.url; }
            }
            if (!directLink || !directLink.startsWith('http')) { return res.status(500).json({ error: 'Não foi possível obter o link de download direto para MP4.' }); }
            const outputFileName = `${videoTitleBase}.mp4`;
            return res.json({ success: true, message: 'Link de download MP4 pronto!', downloadUrl: directLink, fileName: outputFileName, title: metadataJson.title, mimeType: 'video/mp4' });
        } else {
            return res.status(400).json({ error: 'Formato inválido.' });
        }

    } catch (error) {
        console.error('Erro detalhado no servidor:', error);
        res.status(500).json({ error: 'Erro ao processar o vídeo.', details: error.message });
    } finally {
        if (downloadedAudioFilePath) {
            try { if (existsSync(downloadedAudioFilePath)) { await fs.unlink(downloadedAudioFilePath); console.log(`Arquivo de áudio temporário ${downloadedAudioFilePath} deletado.`); }
            } catch (cleanupError) { console.error(`Erro ao deletar ${downloadedAudioFilePath}:`, cleanupError); }
        }
    }
});

app.get('/downloads/:filename', async (req, res) => {
    const { filename } = req.params;
    const filePath = path.join(TEMP_DOWNLOAD_DIR, filename);
    try {
        if (existsSync(filePath)) {
            res.download(filePath, filename, async (err) => {
                if (err) { if (!res.headersSent) { res.status(500).send('Erro ao baixar.'); } } // Adicionado para evitar crash se headers já enviados
                else { 
                    // Tenta deletar o arquivo APÓS o download ter sido enviado (ou tentado)
                    // Adicionamos uma pequena espera para garantir que o stream de download teve chance de iniciar
                    setTimeout(async () => {
                        try {
                            if (existsSync(filePath)) { 
                                await fs.unlink(filePath); 
                                console.log(`Arquivo ${filePath} deletado após download.`);
                            }
                        } catch (e) { 
                            console.error("Erro ao deletar arquivo após download:", filePath, e);
                        }
                    }, 1000); // Espera 1 segundo
                }
            });
        } else { res.status(404).send('Arquivo não encontrado.'); }
    } catch (error) { 
        console.error("Erro na rota /downloads:", error);
        if (!res.headersSent) { res.status(500).send('Erro interno do servidor.'); } 
    }
});

app.listen(port, () => {
    console.log(`Servidor backend rodando em http://localhost:${port}`);
    console.log(`Usando fluent-ffmpeg com @ffmpeg-installer/ffmpeg para conversões MP3.`);
    if (ffmpegInstaller.path) {
        console.log(`Caminho do FFmpeg (via @ffmpeg-installer): ${ffmpegInstaller.path}`);
    } else {
        console.warn("Não foi possível determinar o caminho do FFmpeg via @ffmpeg-installer/ffmpeg. A conversão PODE FALHAR.");
        console.warn("Certifique-se de que o pacote '@ffmpeg-installer/ffmpeg' foi instalado corretamente e que não houve erros durante 'npm install'.");
        console.warn("Em alguns sistemas, pode ser necessário instalar o FFmpeg manualmente e adicioná-lo ao PATH do sistema se o @ffmpeg-installer falhar.");
    }
});