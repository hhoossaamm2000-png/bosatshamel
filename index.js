const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

// ================= إعدادات البيئة (مخفية) =================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || ''; 
const CHAT_ID = process.env.CHAT_ID || ''; 
const BOSTA_USER = process.env.BOSTA_USER || '';
const BOSTA_PASS = process.env.BOSTA_PASS || '';
const PROJECT_NAME = 'بوسطة الشامل (آخر شهرين مقسمة)';
// ===============================================================

// دالة إرسال رسائل التليجرام
async function sendTelegramMsg(text) {
    if (!TELEGRAM_TOKEN || !CHAT_ID) return; // تخطي لو مفيش بيانات تليجرام
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

// دالة لتقسيم آخر 60 يوم إلى فترات كل منها 10 أيام
function getDateChunks(totalDays = 60, interval = 10) {
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
        console.error('❌ خطأ: لم يتم العثور على بيانات الدخول لبوسطة في الإعدادات المخفية.');
        process.exit(1);
    }

    const downloadPath = path.resolve(__dirname, 'downloads');
    
    // تنظيف مجلد التحميل قبل البدء
    if (!fs.existsSync(downloadPath)){
        fs.mkdirSync(downloadPath);
    } else {
        fs.readdirSync(downloadPath).forEach(f => {
            try { fs.unlinkSync(path.join(downloadPath, f)); } catch(e) {}
        });
    }

    await sendTelegramMsg('🚀 <b>بدأ التنفيذ الآن...</b>\nجاري سحب تقرير آخر 60 يوم لجميع العملاء (مقسم لـ 6 ملفات).');

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
    
    // منع تحميل الموارد غير الضرورية لتسريع التصفح
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
            req.abort();
        } else {
            req.continue();
        }
    });

    page.on('dialog', async dialog => { await dialog.accept(); });
    page.setDefaultTimeout(90000);

    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadPath });

    try {
        console.log('1️⃣ تسجيل الدخول لبوسطة...');
        await page.goto('https://bosatexpress.com/home', { waitUntil: 'networkidle0' });

        await page.waitForSelector('input[type="text"]');
        
        // استخدام المتغيرات المخفية هنا
        await page.type('input[type="text"]', BOSTA_USER);
        await page.type('input[type="password"]', BOSTA_PASS);

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2' }),
            page.keyboard.press('Enter')
        ]);

        console.log('2️⃣ الانتقال لصفحة التقارير...');
        await page.goto('https://bosatexpress.com/FollowUpOrdersRep', { waitUntil: 'networkidle2' });

        // تعديل دالة التحميل للعمل في الخلفية لجميع الملفات
        await page.evaluate(() => {
            window.open = function(url) {
                const iframe = document.createElement('iframe');
                iframe.style.display = 'none';
                iframe.src = url;
                document.body.appendChild(iframe);
                return iframe.contentWindow;
            };
        });

        // جلب الفترات الزمنية
        const chunks = getDateChunks(60, 10);
        console.log(`تم تقسيم الفترة إلى ${chunks.length} أجزاء.`);

        // حلقة تكرار لاستخراج كل 10 أيام في ملف منفصل
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            console.log(`\n⏳ جاري سحب الجزء [${i + 1}/${chunks.length}]: من ${chunk.start} إلى ${chunk.end}`);

            // تحديد التواريخ
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

            // الضغط على عرض النتائج
            await page.evaluate(() => {
                const execBtn = document.querySelector('#ArMainContent_UcFollowUpOrdersReport_LnkExecs');
                if(execBtn) execBtn.click();
            }); 
            
            // انتظار تحميل الجدول
            await page.waitForSelector('#ArMainContent_UcFollowUpOrdersReport_GrdOrders', { timeout: 60000 });
            await new Promise(r => setTimeout(r, 8000)); // وقت إضافي لضمان استقرار الشبكة

            // تسجيل عدد الملفات قبل التحميل
            const filesBefore = fs.readdirSync(downloadPath).length;

            // طلب الإكسيل
            await page.evaluate(() => {
                if (typeof printFunc === 'function') printFunc('FollowUpOrdersXlsRep');
            });

            // انتظار نزول الملف الجديد
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
                // إعادة تسمية الملف لتمييزه
                const oldPath = path.join(downloadPath, newFileName);
                const newPath = path.join(downloadPath, `chunk_${i + 1}_${Date.now()}.xls`);
                fs.renameSync(oldPath, newPath);
                console.log(`✅ تم تحميل: chunk_${i + 1} (${(fs.statSync(newPath).size/1024).toFixed(1)} KB)`);
            } else {
                console.log(`⚠️ فشل تحميل الجزء ${i + 1}، جاري التخطي...`);
            }
        }

        console.log('\n3️⃣ الانتقال لصفحة جوجل سكربت الجديدة للرفع...');
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

        if (!targetFrame) throw new Error("لم يتم العثور على إطار جوجل سكربت.");

        // محاولة إدخال الباسورد لو موجود
        try {
            const passInput = await targetFrame.$('input[type="password"], .login-input');
            if (passInput) {
                await passInput.type('202020');
                await targetFrame.keyboard.press('Enter');
                await new Promise(r => setTimeout(r, 8000));
            }
        } catch (e) {}

        console.log('4️⃣ تجهيز ورفع جميع الملفات...');
        await targetFrame.waitForSelector('#excelFile', { timeout: 20000 });
        const fileInput = await targetFrame.$('#excelFile');
        
        // جلب مسارات كل الملفات الموجودة في الفولدر
        const filesToUpload = fs.readdirSync(downloadPath)
                                .filter(f => !f.endsWith('.crdownload'))
                                .map(f => path.join(downloadPath, f));

        console.log(`سيتم رفع عدد ${filesToUpload.length} ملفات...`);
        
        // تمرير جميع الملفات للرفع
        await fileInput.uploadFile(...filesToUpload);
        
        // الضغط على زر الدمج والرفع
        await targetFrame.$eval('button[onclick="processFiles()"]', btn => btn.click());

        console.log('⏳ انتظار معالجة ودمج الملفات (120 ثانية)...');
        await new Promise(r => setTimeout(r, 120000)); 
        
        console.log('🎉 تم الرفع بنجاح!');
        await sendTelegramMsg(`🎉 <b>نجح التحديث!</b>\nتم سحب الشحنات الشاملة آخر 60 يوم ورفع ${filesToUpload.length} ملفات بنجاح.`);

    } catch (error) {
        console.error('❌ خطأ:', error.message);
        try {
            const screenshotPath = path.join(downloadPath, 'error.png');
            await page.screenshot({ path: screenshotPath, fullPage: true });
            await sendTelegramMsg(`❌ <b>خطأ:</b>\n<code>${error.message}</code>\n📸 لقطة شاشة مرفقة`);
        } catch(e) {}
        process.exit(1);
    } finally {
        await browser.close();
    }
})();
