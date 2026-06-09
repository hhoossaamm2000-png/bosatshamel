const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

// ================= إعدادات البيئة =================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || ''; 
const CHAT_ID = process.env.CHAT_ID || ''; 
const BOSTA_USER = process.env.BOSTA_USER || '';
const BOSTA_PASS = process.env.BOSTA_PASS || '';
const PROJECT_NAME = 'بوسطة الشامل (بالكتابة اليدوية للتواريخ)';
// ===================================================

let globalNoData = false; 

async function sendTelegramMsg(text) {
    if (!TELEGRAM_TOKEN || !CHAT_ID) return; 
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        const formattedMsg = `🔔 <b>${PROJECT_NAME}</b>\n${text}`;
        await fetch(url, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ chat_id: CHAT_ID, text: formattedMsg, parse_mode: 'HTML' }) 
        });
    } catch (e) {
        console.error('خطأ في إرسال التليجرام:', e.message);
    }
}

async function sendTelegramPhoto(imagePath, captionText) {
    if (!TELEGRAM_TOKEN || !CHAT_ID) return;
    try {
        const buffer = fs.readFileSync(imagePath);
        const blob = new Blob([buffer], { type: 'image/png' });
        const formData = new FormData();
        formData.append('chat_id', CHAT_ID);
        formData.append('photo', blob, 'screenshot.png');
        if (captionText) {
            formData.append('caption', `🔔 <b>${PROJECT_NAME}</b>\n${captionText}`);
            formData.append('parse_mode', 'HTML');
        }

        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`;
        await fetch(url, {
            method: 'POST',
            body: formData
        });
        
        fs.unlinkSync(imagePath);
    } catch (e) {
        console.error('خطأ في إرسال الصورة:', e.message);
    }
}

function getDateChunks(totalDays = 60, interval = 5) {
    const chunks = [];
    const endDate = new Date(); 
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - totalDays + 1);

    let currentStart = new Date(startDate);
    while (currentStart <= endDate) {
        let currentEnd = new Date(currentStart);
        currentEnd.setDate(currentStart.getDate() + interval - 1);
        if (currentEnd > endDate) currentEnd = new Date(endDate);

        const format = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
        
        chunks.push({ start: format(currentStart), end: format(currentEnd) });
        
        currentStart = new Date(currentEnd);
        currentStart.setDate(currentStart.getDate() + 1);
    }
    return chunks;
}

(async () => {
    if (!BOSTA_USER || !BOSTA_PASS) {
        console.error('❌ خطأ: لم يتم العثور على بيانات الدخول.');
        process.exit(1);
    }

    const downloadPath = path.resolve(__dirname, 'downloads');
    
    if (!fs.existsSync(downloadPath)){
        fs.mkdirSync(downloadPath);
    } else {
        fs.readdirSync(downloadPath).forEach(f => {
            try { fs.unlinkSync(path.join(downloadPath, f)); } catch(e) {}
        });
    }

    await sendTelegramMsg('🚀 <b>بدأ التنفيذ...</b>\nتم تفعيل ميزة الكتابة اليدوية للتواريخ لضمان استجابة الموقع.');

    let browser = await puppeteer.launch({ 
        headless: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-web-security',
            '--max-old-space-size=6144',
            '--window-size=1280,800'
        ],
        defaultViewport: { width: 1280, height: 800 }
    });
    
    let page = await browser.newPage();
    
    async function setupPage(p) {
        p.on('dialog', async dialog => { 
            const msg = dialog.message() || '';
            console.log(`💬 رسالة من بوسطة: ${msg}`);
            if (msg.includes('بيانات') || msg.includes('لا توجد') || msg.includes('found') || msg.includes('No')) {
                globalNoData = true;
            }
            await dialog.accept(); 
        });
        
        p.setDefaultTimeout(120000); 
        const client = await p.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadPath });
    }

    await setupPage(page);

    try {
        console.log('1️⃣ تسجيل الدخول الأول لبوسطة...');
        await page.goto('https://bosatexpress.com/home', { waitUntil: 'networkidle0' });

        await page.waitForSelector('input[type="text"]');
        await page.type('input[type="text"]', BOSTA_USER);
        await page.type('input[type="password"]', BOSTA_PASS);

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2' }),
            page.keyboard.press('Enter')
        ]);

        const loginPicPath = path.join(downloadPath, 'login.png');
        await page.screenshot({ path: loginPicPath });
        await sendTelegramPhoto(loginPicPath, '✅ تم تسجيل الدخول لبوسطة بنجاح.');

        const chunks = getDateChunks(60, 5); 
        console.log(`تم تقسيم الفترة إلى ${chunks.length} أجزاء (كل جزء 5 أيام).`);

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            let success = false;
            let attempts = 0;
            const maxAttempts = 4;

            while (!success && attempts < maxAttempts) {
                globalNoData = false; 
                attempts++;
                const partMsg = `الجزء [${i + 1}/${chunks.length}]: من ${chunk.start} إلى ${chunk.end} (المحاولة ${attempts}/${maxAttempts})`;
                console.log(`\n⏳ جاري سحب ${partMsg}`);

                try {
                    await page.goto('https://bosatexpress.com/FollowUpOrdersRep', { waitUntil: 'networkidle2' });

                    await page.evaluate(() => {
                        window.open = function(url) {
                            const iframe = document.createElement('iframe');
                            iframe.style.display = 'none';
                            iframe.src = url;
                            document.body.appendChild(iframe);
                            return iframe.contentWindow;
                        };
                    });

                    // 🌟 التعديل الجذري: كتابة التاريخ يدوياً 🌟
                    const fromInputId = '#ArMainContent_UcFollowUpOrdersReport_Txt_From_Date';
                    const toInputId = '#ArMainContent_UcFollowUpOrdersReport_Txt_To_Date';
                    const execBtnId = '#ArMainContent_UcFollowUpOrdersReport_LnkExecs';

                    // انتظار ظهور الخانة في الصفحة
                    await page.waitForSelector(fromInputId, { visible: true, timeout: 30000 });
                    await new Promise(r => setTimeout(r, 2000)); // وقت لاستقرار الموقع

                    // مسح الخانات وكتابة التاريخ زي ما الإنسان بيعمل
                    await page.$eval(fromInputId, el => el.value = '');
                    await page.type(fromInputId, chunk.start, { delay: 50 }); // حرف حرف

                    await page.$eval(toInputId, el => el.value = '');
                    await page.type(toInputId, chunk.end, { delay: 50 }); // حرف حرف

                    // الضغط على زر Tab عشان الموقع يستوعب التغيير
                    await page.keyboard.press('Tab');
                    await new Promise(r => setTimeout(r, 1000));

                    // الضغط على زرار البحث
                    await page.waitForSelector(execBtnId, { visible: true });
                    await page.click(execBtnId);
                    
                    await new Promise(r => setTimeout(r, 4000));
                    
                    if (globalNoData) {
                        console.log('⏩ مفيش شحنات في الـ 5 أيام دول (تخطي ذكي فوراً)...');
                        success = true; 
                        break; 
                    }
                    
                    await page.waitForSelector('#ArMainContent_UcFollowUpOrdersReport_GrdOrders, [id*="GrdOrders"], table', { timeout: 90000 });
                    console.log('✅ الجدول ظهر، طلب الملف...');
                    
                    // تصوير الجدول (دلوقتي هتشوف التواريخ مكتوبة بوضوح في الصورة)
                    const tablePicPath = path.join(downloadPath, `table_${i}.png`);
                    await page.screenshot({ path: tablePicPath });
                    await sendTelegramPhoto(tablePicPath, `✅ الجدول ظهر لـ ${partMsg}`);

                    const filesBefore = fs.readdirSync(downloadPath).length;

                    await page.evaluate(() => {
                        if (typeof printFunc === 'function') printFunc('FollowUpOrdersXlsRep');
                    });

                    let newFileName = null;
                    for (let t = 0; t < 60; t++) { 
                        const filesAfter = fs.readdirSync(downloadPath);
                        if (filesAfter.length > filesBefore) {
                            const latestFile = filesAfter.find(f => 
                                !f.endsWith('.crdownload') && fs.statSync(path.join(downloadPath, f)).size > 50
                            );
                            if (latestFile) {
                                newFileName = latestFile;
                                break;
                            }
                        }
                        await new Promise(r => setTimeout(r, 2000));
                    }

                    if (newFileName) {
                        const oldPath = path.join(downloadPath, newFileName);
                        const newPath = path.join(downloadPath, `chunk_${i + 1}_${Date.now()}.xls`);
                        fs.renameSync(oldPath, newPath);
                        console.log(`📥 تم تحميل الجزء [${i + 1}] بنجاح!`);
                        success = true; 
                    } else {
                        throw new Error("تأخر الملف (احتمال حظر من السيرفر أو الجدول فارغ بدون رسالة)");
                    }

                } catch (error) {
                    console.log(`⚠️ المحاولة ${attempts} فشلت: ${error.message}`);
                    
                    const errorPicPath = path.join(downloadPath, `error_${i}_${attempts}.png`);
                    await page.screenshot({ path: errorPicPath });
                    await sendTelegramPhoto(errorPicPath, `⚠️ خطأ في ${partMsg}\n<code>${error.message}</code>`);

                    if (attempts < maxAttempts) {
                        console.log('🔄 جاري عمل (Hard Reset)...');
                        await sendTelegramMsg('🔄 جاري عمل Hard Reset للمتصفح لتجاوز الحظر...');
                        try {
                            await browser.close(); 
                            browser = await puppeteer.launch({ 
                                headless: true,
                                args: [
                                    '--no-sandbox', 
                                    '--disable-setuid-sandbox', 
                                    '--disable-web-security',
                                    '--max-old-space-size=6144',
                                    '--window-size=1280,800'
                                ],
                                defaultViewport: { width: 1280, height: 800 }
                            });
                            
                            page = await browser.newPage();
                            await setupPage(page);
                            
                            console.log('🔐 تسجيل الدخول من الصفر...');
                            await page.goto('https://bosatexpress.com/home', { waitUntil: 'networkidle0' });
                            await page.waitForSelector('input[type="text"]');
                            await page.type('input[type="text"]', BOSTA_USER);
                            await page.type('input[type="password"]', BOSTA_PASS);
                            await Promise.all([
                                page.waitForNavigation({ waitUntil: 'networkidle2' }),
                                page.keyboard.press('Enter')
                            ]);
                            console.log('✅ تم تسجيل الدخول بنجاح، جاري استئناف التحميل...');
                        } catch (e) {
                            console.log('❌ خطأ أثناء عمل Reset للمتصفح:', e.message);
                        }
                    } else {
                        console.log(`❌ فشل نهائي للجزء [${i + 1}]. جاري التخطي...`);
                        await sendTelegramMsg(`❌ فشل نهائي في سحب الجزء [${i + 1}] بعد 4 محاولات.`);
                    }
                }
            }
        }

        console.log('\n3️⃣ الانتقال لصفحة جوجل سكربت للرفع...');
        await page.goto('https://script.google.com/macros/s/AKfycbyca-1Xqh_69GQ8LgEqcNys6ZZ7UpwwwVK1I5-Q-CsrjTjpnndn6fHBeWNnyEcIDUk/exec', { 
            waitUntil: 'networkidle2' 
        });
        await new Promise(r => setTimeout(r, 8000)); 

        const gscriptPicPath = path.join(downloadPath, 'gscript.png');
        await page.screenshot({ path: gscriptPicPath });
        await sendTelegramPhoto(gscriptPicPath, '🔄 تم فتح صفحة الرفع وجاري تجهيز الملفات...');

        let targetFrame = null;
        for (const frame of page.frames()) {
            if (await frame.$('#excelFile') || await frame.$('input[type="password"]')) {
                targetFrame = frame;
                break;
            }
        }

        if (!targetFrame) throw new Error("إطار جوجل سكربت غير موجود.");

        try {
            const passInput = await targetFrame.$('input[type="password"], .login-input');
            if (passInput) {
                await passInput.type('202020');
                await targetFrame.keyboard.press('Enter');
                await new Promise(r => setTimeout(r, 8000));
            }
        } catch (e) {}

        await targetFrame.waitForSelector('#excelFile', { timeout: 20000 });
        const fileInput = await targetFrame.$('#excelFile');
        
        const filesToUpload = fs.readdirSync(downloadPath)
                                .filter(f => !f.endsWith('.crdownload') && (f.endsWith('.xls') || f.endsWith('.xlsx') || f.endsWith('.csv')))
                                .map(f => path.join(downloadPath, f));

        if (filesToUpload.length === 0) {
            console.log('⚠️ لم يتم تحميل أي ملفات. سيتم إنهاء السكريبت.');
            await sendTelegramMsg('⚠️ <b>تنبيه:</b> انتهى الفحص ولم يتم العثور على أي ملفات لرفعها.');
            process.exit(0);
        }

        console.log(`سيتم رفع عدد ${filesToUpload.length} ملفات دفعة واحدة...`);
        
        await fileInput.uploadFile(...filesToUpload);
        await targetFrame.$eval('button[onclick="processFiles()"]', btn => btn.click());

        console.log('⏳ انتظار معالجة ودمج الملفات...');
        await new Promise(r => setTimeout(r, 120000)); 
        
        console.log('🎉 تم الرفع بنجاح!');
        await sendTelegramMsg(`🎉 <b>نجح التحديث!</b>\nتم سحب الشحنات الشاملة ورفع ${filesToUpload.length} ملفات بنجاح.`);

    } catch (error) {
        console.error('❌ خطأ:', error.message);
        try {
            const fatalErrorPicPath = path.join(downloadPath, 'fatal_error.png');
            await page.screenshot({ path: fatalErrorPicPath, fullPage: true });
            await sendTelegramPhoto(fatalErrorPicPath, `❌ <b>توقف السكريبت بخطأ فادح:</b>\n<code>${error.message}</code>`);
        } catch(e) {}
        process.exit(1);
    } finally {
        if (browser) await browser.close();
    }
})();
