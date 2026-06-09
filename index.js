const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

// ================= إعدادات البيئة =================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || ''; 
const CHAT_ID = process.env.CHAT_ID || ''; 
const BOSTA_USER = process.env.BOSTA_USER || '';
const BOSTA_PASS = process.env.BOSTA_PASS || '';
const PROJECT_NAME = 'بوسطة الشامل (آخر شهرين - 5 أيام)';
// ===================================================

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

// تعديل الدالة لتقسيم المدة لـ 5 أيام زي ما اقترحت
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

    await sendTelegramMsg('🚀 <b>بدأ التنفيذ...</b>\nجاري سحب تقرير آخر 60 يوم لجميع العملاء (مقسم 5 أيام).');

    const browser = await puppeteer.launch({ 
        headless: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-web-security',
            '--disable-images',
            '--max-old-space-size=6144'
        ] 
    });
    
    const page = await browser.newPage();
    
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
            req.abort();
        } else {
            req.continue();
        }
    });

    page.on('dialog', async dialog => { await dialog.accept(); });
    page.setDefaultTimeout(120000); // زيادة التايم أوت العام

    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadPath });

    try {
        console.log('1️⃣ تسجيل الدخول لبوسطة...');
        await page.goto('https://bosatexpress.com/home', { waitUntil: 'networkidle0' });

        await page.waitForSelector('input[type="text"]');
        await page.type('input[type="text"]', BOSTA_USER);
        await page.type('input[type="password"]', BOSTA_PASS);

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2' }),
            page.keyboard.press('Enter')
        ]);

        const chunks = getDateChunks(60, 5); // 5 أيام
        console.log(`تم تقسيم الفترة إلى ${chunks.length} أجزاء (كل جزء 5 أيام).`);

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            console.log(`\n⏳ جاري سحب الجزء [${i + 1}/${chunks.length}]: من ${chunk.start} إلى ${chunk.end}`);

            // ⚠️ التعديل الجوهري: فتح الصفحة من جديد كل مرة لتنظيف الذاكرة وتجنب تهنيج السيرفر
            await page.goto('https://bosatexpress.com/FollowUpOrdersRep', { waitUntil: 'networkidle2' });

            // إعادة حقن دالة التحميل بعد الـ Refresh
            await page.evaluate(() => {
                window.open = function(url) {
                    const iframe = document.createElement('iframe');
                    iframe.style.display = 'none';
                    iframe.src = url;
                    document.body.appendChild(iframe);
                    return iframe.contentWindow;
                };
            });

            await page.evaluate((start, end) => {
                const fromInput = document.querySelector('#ArMainContent_UcFollowUpOrdersReport_Txt_From_Date');
                const toInput = document.querySelector('#ArMainContent_UcFollowUpOrdersReport_Txt_To_Date');
                if(fromInput && toInput) {
                    fromInput.value = start;
                    fromInput.dispatchEvent(new Event('change', { bubbles: true }));
                    toInput.value = end;
                    toInput.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }, chunk.start, chunk.end);

            await page.evaluate(() => {
                const execBtn = document.querySelector('#ArMainContent_UcFollowUpOrdersReport_LnkExecs');
                if(execBtn) execBtn.click();
            }); 
            
            try {
                // ⚠️ استخدام طريقة الكود القديم لضمان إيجاد الجدول
                await page.waitForSelector('#ArMainContent_UcFollowUpOrdersReport_GrdOrders, [id*="GrdOrders"], table', { timeout: 90000 });
                console.log('✅ الجدول ظهر، انتظار التحميل الكامل...');
                await new Promise(r => setTimeout(r, 15000)); // وقت إضافي لضمان استقرار الداتا الكبيرة

                const filesBefore = fs.readdirSync(downloadPath).length;

                await page.evaluate(() => {
                    if (typeof printFunc === 'function') printFunc('FollowUpOrdersXlsRep');
                });

                let newFileName = null;
                for (let t = 0; t < 60; t++) {
                    const filesAfter = fs.readdirSync(downloadPath);
                    if (filesAfter.length > filesBefore) {
                        const latestFile = filesAfter.find(f => 
                            !f.endsWith('.crdownload') && fs.statSync(path.join(downloadPath, f)).size > 1000
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
                    console.log(`📥 تم تحميل الجزء بنجاح!`);
                } else {
                    console.log(`⚠️ فشل تحميل الجزء، جاري التخطي...`);
                }

            } catch (error) {
                console.log(`⚠️ الجدول مظهرش (مفيش شحنات أو السيرفر تقيل). هنتخطى ونكمل...`);
            }
        }

        console.log('\n3️⃣ الانتقال لصفحة جوجل سكربت للرفع...');
        await page.goto('https://script.google.com/macros/s/AKfycbyca-1Xqh_69GQ8LgEqcNys6ZZ7UpwwwVK1I5-Q-CsrjTjpnndn6fHBeWNnyEcIDUk/exec', { 
            waitUntil: 'networkidle2' 
        });
        await new Promise(r => setTimeout(r, 5000));

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
                                .filter(f => !f.endsWith('.crdownload'))
                                .map(f => path.join(downloadPath, f));

        if (filesToUpload.length === 0) {
            console.log('⚠️ لم يتم تحميل أي ملفات. سيتم إنهاء السكريبت.');
            process.exit(0);
        }

        console.log(`سيتم رفع عدد ${filesToUpload.length} ملفات...`);
        
        await fileInput.uploadFile(...filesToUpload);
        await targetFrame.$eval('button[onclick="processFiles()"]', btn => btn.click());

        console.log('⏳ انتظار معالجة الملفات...');
        await new Promise(r => setTimeout(r, 120000)); 
        
        console.log('🎉 تم الرفع بنجاح!');
        await sendTelegramMsg(`🎉 <b>نجح التحديث!</b>\nتم سحب الشحنات ورفع ${filesToUpload.length} ملفات بنجاح.`);

    } catch (error) {
        console.error('❌ خطأ:', error.message);
        process.exit(1);
    } finally {
        await browser.close();
    }
})();
