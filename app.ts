import './loadEnv.js';
import './patches.js';
import Utility from "./Utility.js";
import os from 'os';
import fs from 'fs';
import axios from 'axios';
import puppeteer, { Page } from 'puppeteer';
import logger from './logger.js';
import { Wallet } from "ethers";
import { faker } from '@faker-js/faker';
import retry from 'async-retry';
import { authenticator } from 'otplib';

declare const protonMail: string;
declare const protonPage: Page;

const MAX_TIMEOUT = Math.pow(2, 31) - 1;

(async () => {
    process.on('SIGTERM', async () => {
        // docker-compose down/stop 会触发 SIGTERM 信号
        logger.info('SIGTERM: 终止请求');
        process.exit();
    });

    // process.on("uncaughtException", (e: Error) => {
    //     logger.error("未捕获的异常", e);
    // });

    const headless = os.platform() == 'linux';

    const chrome = await puppeteer.launch({
        headless,
        defaultViewport: null,//自适应
        protocolTimeout: MAX_TIMEOUT,
        slowMo: 20,
        args: [
            '--lang=en-US',
            '--window-size=1920,1080',
            '--disable-blink-features=AutomationControlled',
            // headless 模式下，Puppeteer 的默认 User-Agent 会包含 "HeadlessChrome" 字样，容易被识别为机器人。
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-zygote',
            '--disable-gpu',
            '--disable-extensions-file-access-check',
            '--disable-extensions-http-throttling'
        ]
    });

    logger.info(chrome.process().spawnfile, await chrome.version(), chrome.wsEndpoint());

    const { PROTONMAIL_USERNAME, PROTONMAIL_PASSWORD } = process.env;
    if (PROTONMAIL_USERNAME && PROTONMAIL_PASSWORD) {
        logger.info("使用环境变量中的用户名和密码");

        const [protonPage] = await chrome.pages();
        await protonPage.goto("https://mail.proton.me");

        await (await protonPage.$x("//input[@id='username']")).type(PROTONMAIL_USERNAME);
        await (await protonPage.$x("//input[@id='password']")).type(PROTONMAIL_PASSWORD);
        await (await protonPage.$x("//button[text()='Sign in']")).click();

        await (await protonPage.$x("//span[text()='🚀 Your GitHub launch code']")).click();
        const emailFrame = await protonPage.waitForFrame(async frame => {
            const frameElement = await frame.frameElement(); // 获取 <iframe> 元素
            const title = await frameElement?.evaluate(el => el.getAttribute('title'));
            return title == "Email content";
        });
        const confirmLink = await emailFrame.textContent("//a[contains(@href, '/account_verifications/confirm/')]");
        logger.info({ confirmLink });

        return;
    }

    const min = 100000000;
    const max = 200000000;

    const username: string = await retry(async (_, attempt) => {
        const randomNum = Math.floor(Math.random() * (max - min + 1)) + min;
        attempt > 1 && logger.info(`第${attempt - 1}次重试，随机数：${randomNum}`);
        const { data: { login: username } } = await axios.get(`https://api.github.com/user/${randomNum}`);
        // 检查长度
        if (username.length > 32)
            throw new Error(`用户名长度超过32，实际为${username.length}，需重新随机`);

        // 只能包含字母、数字、单个连字符，且不能以连字符开头或结尾
        if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(username))
            throw new Error(`用户名 ${username} 不符合规则，需重新随机`);

        return username;
    }, { retries: 10, factor: 1 });

    const wallet = Wallet.createRandom();
    const password = wallet.address.slice(22);

    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();

    logger.info({ username, password, firstName, lastName });

    const [outlookPage] = await chrome.pages();
    await outlookPage.goto("https://outlook.live.com/mail/0/?prompt=create_account");

    await (await outlookPage.$x("//input[@aria-label='New email']", { timeout: MAX_TIMEOUT })).type(username.replace(/^(\d)/, 'u$1'));
    await (await outlookPage.$x("//button[normalize-space(text())='Next']")).click();

    if (await outlookPage.$x("//div[contains(@class, 'fui-TagGroup')]//div[contains(@class, 'fui-InteractionTag')]", { timeout: 5_000 })) {
        logger.info("昵称已经被使用");
        await (await outlookPage.$x("//div[contains(@class, 'fui-TagGroup')]//div[contains(@class, 'fui-InteractionTag')][2]")).click();
        await (await outlookPage.$x("//button[normalize-space(text())='Next']")).click();
    }

    const outlookMail = await outlookPage.textContent("//div[@id='identityBadge']");
    logger.info("Outlook 邮箱地址", outlookMail);

    {
        console.log('Viewport:', outlookPage.viewport());
    const viewportSize = await outlookPage.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }));
  console.log('实际视口大小:', viewportSize);
    }

    await (await outlookPage.$x("//input[@type='password']")).type(password);
    await (await outlookPage.$x("//button[normalize-space(text())='Next']")).click();

    await (await outlookPage.$x("//button[@id='BirthMonthDropdown']")).click();
    await (await outlookPage.$x(`(//div[@role='option'])[${Math.floor(Math.random() * 12) + 1}]`)).click();
    await (await outlookPage.$x("//button[@id='BirthDayDropdown']")).click();
    await (await outlookPage.$x(`(//div[@role='option'])[${Math.floor(Math.random() * 28) + 1}]`)).click();
    await (await outlookPage.$x('//input[@name="BirthYear"]')).type(String(1980 + Math.floor(Math.random() * 30)));
    await (await outlookPage.$x("//button[normalize-space(text())='Next']")).click();

    await (await outlookPage.$x("//input[@id='firstNameInput']")).type(firstName);
    await (await outlookPage.$x("//input[@id='lastNameInput']")).type(lastName);
    await (await outlookPage.$x("//button[normalize-space(text())='Next']")).click();

    logger.info("等待验证真人");
    await outlookPage.waitForSelector("//span[text()='Press and hold the button.']", { timeout: MAX_TIMEOUT });
    const button = await outlookPage.$x("//span[text()='Press and hold the button.']");
    const rect = await outlookPage.evaluate(el => {
        const { x, y, width, height } = el.getBoundingClientRect();
        return { x, y, width, height };
    }, button);

    await Utility.waitForSeconds(5);

    while (true) {
        logger.info("模拟移动鼠标");

        await Utility.humanLikeMouseMove(
            outlookPage.mouse,
            { x: rect.x + Math.random() * rect.width, y: rect.y + Math.random() * rect.height },
            { x: rect.x + Math.random() * rect.width, y: rect.y + 70 },
            40
        );

        await outlookPage.mouse.down();
        await Utility.waitForSeconds(10);
        await outlookPage.mouse.up();

        if (await outlookPage.waitForNavigation({ timeout: 10_000 }))
            break;

        if (outlookPage.url() == "https://outlook.live.com/mail/0/")
            break;
    }

    logger.info("验证通过", outlookPage.url());
    await outlookPage.$x("//span[@id='EmptyState_MainMessage']", { timeout: MAX_TIMEOUT });
    logger.info(`邮箱创建完成，耗时${process.uptime()}秒`);

    // const protonPage = await chrome.newPage();
    // await protonPage.goto("https://account.proton.me/mail/signup?plan=free");

    // const accountFrame = await protonPage.waitForFrame(frame => frame.url() == "https://account-api.proton.me/challenge/v4/html?Type=0&Name=email");
    // await (await accountFrame.$x("//input[@id='username']")).type(outlookMail.split('@')[0]);
    // await (await protonPage.$x("//input[@id='password']")).type(password);
    // await (await protonPage.$x("//input[@id='password-confirm']")).type(password);

    // const protonMail = await (async () => {
    //     while (true) {
    //         await (await protonPage.$x("//button[text()='Start using Proton Mail now']")).click();

    //         const usernameSelector = "xpath=//input[@id='username']";
    //         if (!await accountFrame.$x("//span[text()='Username already used']", { timeout: 5_000, retries: 1 })) {
    //             const username = await accountFrame.$eval(usernameSelector, el => (el as HTMLInputElement).value);
    //             return username + "@proton.me";
    //         }

    //         logger.info("用户名已被使用，重新生成");
    //         await (await accountFrame.$x(usernameSelector)).click({ count: 3 });
    //         await (await accountFrame.$x(usernameSelector)).type(outlookMail.split('@')[0] + Math.floor(Math.random() * 10000));
    //     }
    // })();

    // logger.info("Proton 邮箱地址", protonMail);

    // await (await protonPage.$x("//button[text()='No, thanks']")).click();

    // await protonPage.$x("//h1[text()='Human Verification']");

    // const emailVerification = await protonPage.$x("//button[.//span[text()='Email']]", { timeout: 5_000, retries: 1 });
    // if (emailVerification) {
    //     await emailVerification.hover();
    //     await emailVerification.click();

    //     await (await protonPage.$x("//input[@id='email']")).type(outlookMail);
    //     await (await protonPage.$x("//button[text()='Get verification code']")).click();

    //     logger.info("等待验证邮件");
    //     await outlookPage.bringToFront();
    //     await (await outlookPage.$x("//span[text()='Proton Verification Code']", { retries: 100 })).click();
    //     const code = await outlookPage.textContent("//*[contains(text(),'Your Proton verification code')]/following::span[string-length(normalize-space(text()))=6 and string-length(translate(normalize-space(text()), '0123456789', ''))=0]", { retries: 100 });
    //     logger.info("收到验证邮件", code);
    //     await (await outlookPage.$x("(//button[.//span[text()='Delete this message. (Delete)']])[1]")).click();
    //     await outlookPage.goto("https://outlook.live.com/mail/0/");

    //     await protonPage.bringToFront();
    //     await (await protonPage.$x("//input[@id='verification']")).type(code);
    //     await (await protonPage.$x("//button[text()='Verify']")).click();
    // }
    // else {
    //     // 有时不能用邮箱验证
    //     logger.info("使用 CAPTCHA 验证");
    //     await protonPage.$x("//button[.//span[text()='CAPTCHA']]", { visible: false, hidden: true, retries: 100 });
    // }

    // // Set a display name
    // await (await protonPage.$x("//button[text()='Continue']")).click();
    // // Set up a recovery method
    // await (await protonPage.$x("//button[text()='Maybe later']")).click();
    // // Warning
    // await (await protonPage.$x("//button[text()='Confirm']")).click();
    // // Welcome to Proton Mail
    // await (await protonPage.$x("//button[text()=\"Let's get started\"]")).click();
    // await (await protonPage.$x("//button[text()='Maybe later']")).click();
    // await (await protonPage.$x("//button[text()='Next']")).click();
    // await (await protonPage.$x("//button[text()='Use this']")).click();

    // await protonPage.goto("https://account.proton.me/u/0/mail/recovery");
    // await (await protonPage.$x("//a[text()='Safeguard account now']")).click();
    // await (await protonPage.$x("//div[normalize-space(.)='Show more (2)']")).click();
    // await (await protonPage.$x("//h2[text()='Add a recovery email address']")).click();
    // await (await protonPage.$x("//input[@id='recovery-email-input']")).type(outlookMail);
    // await (await protonPage.$x("//button[text()='Add email address']")).click();
    // await (await protonPage.$x("//input[@id='password']")).type(password);
    // await (await protonPage.$x("//button[text()='Authenticate']")).click();

    // logger.info("等待验证邮件");
    // await outlookPage.bringToFront();
    // await (await outlookPage.$x("//span[text()='Proton Verification Code']", { retries: 100 })).click();
    // const code = await outlookPage.textContent("//*[contains(text(),'Your Proton verification code')]/following::span[string-length(normalize-space(text()))=6 and string-length(translate(normalize-space(text()), '0123456789', ''))=0]", { retries: 100 });
    // logger.info("收到验证邮件", code);
    // await (await outlookPage.$x("(//button[.//span[text()='Delete this message. (Delete)']])[1]")).click();
    // await outlookPage.goto("https://outlook.live.com/mail/0/");

    // await protonPage.bringToFront();
    // for (let i = 0; i < 6; i++) {
    //     await (await protonPage.$x(`//input[@aria-label='Enter verification code. Digit ${i + 1}.']`)).type(code[i]);
    // }
    // await (await protonPage.$x("//button[text()='Verify']")).click();

    // await protonPage.goto("https://mail.proton.me/u/0");
    // logger.info("Proton Mail 设置完成");

    const userMail = typeof protonMail != "undefined" ? protonMail : outlookMail;

    const firefox = await puppeteer.launch({
        browser: "firefox",
        headless,
        defaultViewport: null,//自适应
        protocolTimeout: MAX_TIMEOUT,
        slowMo: 10,
        args: [
            '--lang=en-US',
            '--window-size=1920,1080',
            '--disable-blink-features=AutomationControlled',
            // headless 模式下，Puppeteer 的默认 User-Agent 会包含 "HeadlessChrome" 字样，容易被识别为机器人。
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:139.0) Gecko/20100101 Firefox/139.0',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-zygote',
            '--disable-gpu',
            '--disable-extensions-file-access-check',
            '--disable-extensions-http-throttling'
        ]
    });

    logger.info(firefox.process().spawnfile, await firefox.version(), firefox.wsEndpoint());

    process.on("unhandledRejection", async (e: Error) => {
        logger.error("未处理的拒绝", e);

        const timestamp = new Date().toString().replace(/[:.]/g, '-');
        const pages = await firefox.pages();
        for (let i = 0; i < pages.length; i++) {
            await pages[i].screenshot({ path: `./images/unhandledRejection-${timestamp}-${i + 1}.png` });
        }

        process.exit(1);
    });

    const [page] = await firefox.pages();
    await page.goto("https://github.com/signup");
    await (await page.$x("//input[@placeholder='Email']")).type(userMail);
    await (await page.$x("//input[@placeholder='Password']")).type(password);
    const usernameElement = await page.$x("//input[@placeholder='Username']");
    await usernameElement.type(userMail.split('@')[0]);

    {
        console.log('Viewport:', outlookPage.viewport());
    const viewportSize = await outlookPage.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }));
  console.log('实际视口大小:', viewportSize);

  await page.setViewport({ width: 1920, height: 1080 });

  console.log('Viewport2:', page.viewport());
    const viewportSize2 = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }));
  console.log('实际视口大小2:', viewportSize2);
    }

    while (true) {
        const button = await page.$x("//button[contains(., 'Create account')]");

        const rect = await page.evaluate(el => {
            const { x, y, width, height } = el.getBoundingClientRect();
            return { x, y, width, height };
        }, button);

        await Utility.humanLikeMouseMove(
            page.mouse,
            { x: rect.x, y: rect.y },
            { x: rect.x + Math.random() * rect.width, y: rect.y + Math.random() * rect.height },
            40
        );

        const usernameInputElement = await page.$x("//input[@placeholder='Username' and (contains(@class, 'is-autocheck-successful') or contains(@class, 'is-autocheck-errored'))]");
        if (!usernameInputElement)
            continue;

        const usernameInputClassName = await usernameInputElement.evaluate(el => el.className);
        logger.info(usernameInputClassName.includes('is-autocheck-successful') ? "用户名校验成功" : "用户名校验失败");

        if (usernameInputClassName.includes('is-autocheck-successful'))
            break;

        await Utility.waitForSeconds(1);
        await usernameElement.click({ count: 3 });
        await usernameElement.type(userMail.split('@')[0] + Math.floor(Math.random() * 10000));
    }

    const account = await usernameElement.evaluate(el => (el as HTMLInputElement).value);
    logger.info("即将注册", account);

    await page.waitForNetworkIdle();
    await (await page.$x("//button[contains(., 'Create account')]")).click();

    const frame = await page.waitForFrame(async frame => {
        const frameElement = await frame.frameElement();
        if (!frameElement)
            return false;

        const id = await frameElement.evaluate(el => el.getAttribute('id'));
        return id == 'game-core-frame';
    }, { timeout: 15_000 });

    if (frame) {
        logger.info("需要验证");
        await (await frame.$x("//button[contains(., 'Visual puzzle')]")).click();
        await frame.$x("//button[contains(., 'Submit')]");
        logger.info("等待验证真人");
    }

    // for (let i = 1; i <= 8; i++) {
    //     const img = await frame.$x(`//img[@aria-label="Image ${i} of 8."]`);
    //     await img.screenshot({ path: `image${i}.png` });
    // }

    await page.$x("//h2[text()='Confirm your email address']", { timeout: MAX_TIMEOUT });
    logger.info("等待验证邮件");
    const mailPage = typeof protonPage != "undefined" ? protonPage : outlookPage;
    await mailPage.bringToFront();
    await (await mailPage.$x("//span[text()='🚀 Your GitHub launch code']")).click();
    logger.info("收到验证邮件");

    if (await mailPage.$("//button[.//span[text()='OK']]")) {
        logger.info("出现OK按钮");
        await mailPage.click("//button[.//span[text()='OK']]");
    }

    const emailFrame = mailPage.url().includes("outlook") ? mailPage.mainFrame() : await mailPage.waitForFrame(async frame => {
        const frameElement = await frame.frameElement(); // 获取 <iframe> 元素
        const title = await frameElement?.evaluate(el => el.getAttribute('title'));
        return title == "Email content";
    });
    const confirmLink = await emailFrame.textContent("//a[contains(@href, '/account_verifications/confirm/')]", { timeout: MAX_TIMEOUT });
    logger.info({ confirmLink });

    await page.bringToFront();
    await page.goto(confirmLink);

    await page.$x("//div[contains(text(), 'account was created successfully')]");
    logger.info("账号创建成功");

    await (await page.$x("//input[@id='login_field']")).type(userMail);
    await (await page.$x("//input[@id='password']")).type(password);
    await (await page.$x("//input[@value='Sign in']")).click();
    logger.info("登录成功", page.url());

    const { status } = await axios.get(`https://github.com/${account}`).catch(e => e.response);
    if (status != 200) {
        logger.info("账号异常");
        return;
    }

    await (await page.$x("//a[.//span[text()='Update profile']]")).click();
    await (await page.$x("//a[.//span[contains(text(), 'Password and authentication')]]")).click();
    await (await page.$x("//a[.//span[text()='Enable two-factor authentication']]")).click();
    await (await page.$x("//button[@id='dialog-show-two-factor-setup-verification-mashed-secret']", { timeout: MAX_TIMEOUT })).click();
    await Utility.waitForSeconds(1);
    const otpSecret = await page.textContent("//div[@data-target='two-factor-setup-verification.mashedSecret']");

    logger.info({ otp: otpSecret });

    const otp = authenticator.generate(otpSecret);

    await (await page.$x("//button[@data-close-dialog-id='two-factor-setup-verification-mashed-secret']")).click();
    await (await page.$x("//input[@name='otp']")).type(otp);

    await Utility.waitForSeconds(1);
    await (await page.$x("//button[@data-action='click:two-factor-setup-recovery-codes#onDownloadClick']")).click();
    await (await page.$x('//button[contains(., "I have saved my recovery codes") and not(@disabled)]')).click();
    await page.$x('//*[contains(., "Two-factor authentication (2FA) is now enabled for your GitHub account")]');
    logger.info("成功设置2FA");

    await (await page.$x("//button[contains(., 'Done')]")).click();
    await (await page.$x("//a[@href='/settings/apps']")).click();// Developer settings
    await Utility.waitForSeconds(1);
    await (await page.$x("//button[@id='personal-access-tokens-menu-item']")).click();
    await Utility.waitForSeconds(1);
    await (await page.$x("//a[@href='/settings/tokens']")).click();
    await (await page.$x("//summary[.//span[normalize-space(text())='Generate new token']]")).click();
    await (await page.$x("//a[.//div[text()[contains(., 'Generate new token (classic)')]]]")).click();

    await (await page.$x("//input[@id='oauth_access_description']")).type("API testing");
    await (await page.$x("//button[.//span[contains(text(), '30 days')]]")).click();
    await (await page.$x("//button[.//span[normalize-space(text())='No expiration']]")).click();

    await (await page.$x("//span[text()='repo']")).click();
    await (await page.$x("//span[text()='workflow']")).click();
    await (await page.$x("//span[text()='admin:org']")).click();
    await (await page.$x("//span[text()='user']")).click();
    await (await page.$x("//span[text()='delete_repo']")).click();

    await (await page.$x("//button[normalize-space(text())='Generate token']")).click();
    const token = await page.textContent("//code[@id='new-oauth-token']");

    const data = ["", `# ${new Date().toString()}`, JSON.stringify([account, password, otpSecret]), `GITHUB_USERNAME=${account}`, `GITHUB_PASSWORD=${password}`, `GITHUB_SECRET=${otpSecret}`, `# https://${token}@github.com/${account}/${account}.git`, ""].join('\n');
    logger.info(data);
    fs.appendFileSync("../VirtualMachine/.env.development", data);

    await chrome.close();
    await firefox.close();
})();