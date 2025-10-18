import './loadEnv.js';
import './patches.js';
import Utility from "./Utility.js";
import os from 'os';
import axios from 'axios';
import puppeteer, { Browser, Page } from 'puppeteer';
import logger from './logger.js';
import { Wallet } from "ethers";
import { faker } from '@faker-js/faker';
import retry from 'async-retry';
import { authenticator } from 'otplib';
import githubAnnotation from './annotations.js';
import { Redis } from '@upstash/redis';

const { ENABLE_OUTLOOK_REGISTER, ENABLE_PROTON_REGISTER, ENABLE_CHATGPT_REGISTER, ENABLE_DENGTA_REGISTER, ENABLE_DOCKER_REGISTER, UPSTASH_REDIS_URL, UPSTASH_REDIS_TOKEN } = process.env;
const OUTLOOK_REGISTER_LIMIT = Number(process.env.OUTLOOK_REGISTER_LIMIT);

// const redis = new Redis({
//     url: UPSTASH_REDIS_URL,
//     token: UPSTASH_REDIS_TOKEN
// });

declare const protonMail: string;
declare const protonPage: Page;

const MAX_TIMEOUT = Math.pow(2, 31) - 1;

(async () => {
    const headless = os.platform() == 'linux';

    const chrome = await puppeteer.launch({
        headless,
        defaultViewport: null,
        protocolTimeout: MAX_TIMEOUT,
        slowMo: 20,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        // devtools: true,
        args: [
            '--lang=en-US',
            '--window-size=1920,1080',
            '--disable-blink-features=AutomationControlled',
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

    async function screenshotAllPages() {
        const timestamp = new Date().toString().replace(/[:.]/g, '-');

        const pages = await chrome.pages();
        logger.info("screenshotAllPages", pages.length);
        for (let i = 0; i < pages.length; i++) {
            await pages[i].screenshot({ path: `./images/chrome-${timestamp}-${i + 1}.png` }).catch(logger.error);
        }
    }

    process.on('exit', (code) => {
        // 不能执行异步代码
        logger.info(`进程退出，代码: ${code}，耗时：${Math.round(process.uptime())}秒`);
    });

    process.on('SIGTERM', async () => {
        // timeout docker-compose down/stop 会触发 SIGTERM 信号
        githubAnnotation('error', 'SIGTERM: 终止请求');
        await screenshotAllPages();
        process.exit(1);
    });

    process.on("unhandledRejection", async (e: Error) => {
        githubAnnotation('error', "未处理的拒绝: " + (e.stack || e));
        await screenshotAllPages();
        process.exit(1);
    });

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
    }, { retries: 10, factor: 1 }).catch(_ => undefined);

    if (!username) {
        githubAnnotation('error', "用户名获取失败");
        process.exit(1);
    }

    const wallet = Wallet.createRandom();
    const password = wallet.address.slice(22);

    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();

    logger.info({ username, password, firstName, lastName });

    const [outlookPage] = await chrome.pages();
    await outlookPage.goto("https://outlook.live.com/mail/0/?prompt=create_account");

    do {
        const emailContent = await outlookPage.textContent("//input[@aria-label='New email']", { timeout: MAX_TIMEOUT });
        emailContent && logger.info(emailContent, "昵称已经被使用");
        await outlookPage.type("//input[@aria-label='New email']", username.replace(/^(\d)/, 'u$1') + (emailContent ? Math.floor(Math.random() * 10000) : ""));
        await outlookPage.click("//button[normalize-space(text())='Next']");
        await outlookPage.waitForSelector("//div[contains(@class, 'fui-Field__validationMessage') and @role='alert'] | //input[@type='password']", { timeout: MAX_TIMEOUT });
    } while (await outlookPage.$("//div[contains(@class, 'fui-Field__validationMessage') and @role='alert']"));

    const outlookMail = await outlookPage.textContent("//div[@id='identityBadge']");
    logger.info("Outlook 邮箱地址", outlookMail);

    if (ENABLE_OUTLOOK_REGISTER != "0") {
        await outlookPage.type("//input[@type='password']", password);
        await outlookPage.click("//button[normalize-space(text())='Next']");

        await outlookPage.click("//button[@id='BirthMonthDropdown']");
        await outlookPage.click(`(//div[@role='option'])[${Math.floor(Math.random() * 12) + 1}]`);
        await outlookPage.click("//button[@id='BirthDayDropdown']");
        await outlookPage.click(`(//div[@role='option'])[${Math.floor(Math.random() * 28) + 1}]`);
        await outlookPage.type('//input[@name="BirthYear"]', String(1980 + Math.floor(Math.random() * 30)));
        await outlookPage.click("//button[normalize-space(text())='Next']");

        await outlookPage.type("//input[@id='firstNameInput']", firstName);
        await outlookPage.type("//input[@id='lastNameInput']", lastName);
        await outlookPage.click("//button[normalize-space(text())='Next']");

        const title = await outlookPage.textContent(`//h1[text()="Let's prove you're human" or text()="We can't create your account"]`, { timeout: 30_000 });

        if (title != "Let's prove you're human") {
            githubAnnotation('error', "我们无法创建您的账户, " + title);
            process.exit(1);
        }

        await Utility.waitForSeconds(5);

        const button = await outlookPage.$x("//span[text()='Press and hold the button.']");
        const rect = await outlookPage.evaluate(el => {
            const { x, y, width, height } = el.getBoundingClientRect();
            return { x, y, width, height };
        }, button);

        logger.info("等待验证真人", rect);

        while (true) {
            // if (OUTLOOK_REGISTER_LIMIT) {
            //     const value: number = await redis.get("OUTLOOK_REGISTER_LIMIT");
            //     if (value >= OUTLOOK_REGISTER_LIMIT) {
            //         githubAnnotation('error', "已达到注册上限");
            //         process.exit(1);
            //     }
            // }

            logger.info("模拟移动鼠标");

            await Utility.humanLikeMouseMove(
                outlookPage.mouse,
                { x: rect.x + Math.random() * rect.width, y: rect.y + Math.random() * rect.height },
                { x: rect.x + Math.random() * rect.width, y: rect.y + 60 },
                40
            );

            await outlookPage.mouse.down();
            await Utility.waitForSeconds(10);
            await outlookPage.mouse.up();

            if (await outlookPage.waitForNavigation({ timeout: 10_000 }))
                break;

            if (outlookPage.url() == "https://outlook.live.com/mail/0/")
                break;

            if (process.uptime() > 180) {
                githubAnnotation('error', "验证失败");
                await screenshotAllPages();
                process.exit(1);
            }
        }

        if (OUTLOOK_REGISTER_LIMIT) {
            const value: number = await redis.get("OUTLOOK_REGISTER_LIMIT");
            if (value >= OUTLOOK_REGISTER_LIMIT) {
                githubAnnotation('error', "已达到注册上限");
                process.exit(1);
            }

            await redis.incr("OUTLOOK_REGISTER_LIMIT");
        }

        logger.info("验证通过", outlookPage.url());
        await outlookPage.$x("//span[@id='EmptyState_MainMessage']", { timeout: MAX_TIMEOUT });
        logger.info(`邮箱创建完成，耗时${Math.round(process.uptime())}秒`);

        const consentCheckInterval = setInterval(async () => {
            try {
                for (const frame of outlookPage.frames()) {
                    const ok = await frame.$("//button[@id='unified-consent-continue-button' and not(@disabled)]");
                    if (ok) {
                        await ok.click();
                        logger.info("点击了OK按钮");
                        clearInterval(consentCheckInterval);
                        return;
                    }
                }
            }
            catch (e) {
                logger.error("consentCheckInterval", e.message);
            }
        }, 1_000);
    }

    if (ENABLE_PROTON_REGISTER) {
        const protonPage = await chrome.newPage();
        await protonPage.goto("https://account.proton.me/mail/signup?plan=free");

        const accountFrame = await protonPage.waitForFrame(frame => frame.url() == "https://account-api.proton.me/challenge/v4/html?Type=0&Name=email");
        await accountFrame.type("//input[@id='username']", outlookMail.split('@')[0]);
        await protonPage.type("//input[@id='password']", password);
        await protonPage.type("//input[@id='password-confirm']", password);

        const protonMail = await (async () => {
            while (true) {
                await protonPage.click("//button[text()='Start using Proton Mail now']");

                const usernameSelector = "xpath=//input[@id='username']";
                if (!await accountFrame.$x("//span[text()='Username already used']", { timeout: 5_000 })) {
                    const username = await accountFrame.$eval(usernameSelector, el => (el as HTMLInputElement).value);
                    return username + "@proton.me";
                }

                logger.info("用户名已被使用，重新生成");
                await accountFrame.type(usernameSelector, outlookMail.split('@')[0] + Math.floor(Math.random() * 10000));
            }
        })();

        logger.info("Proton 邮箱地址", protonMail);

        await protonPage.click("//button[text()='No, thanks']");

        await protonPage.$x("//h1[text()='Human Verification']");

        const emailVerification = await protonPage.$x("//button[.//span[text()='Email']]", { timeout: 5_000 });
        if (emailVerification) {
            await emailVerification.hover();
            await emailVerification.click();

            await protonPage.type("//input[@id='email']", outlookMail);
            await protonPage.click("//button[text()='Get verification code']");

            logger.info("等待验证邮件");
            await outlookPage.bringToFront();
            await outlookPage.click("//span[text()='Proton Verification Code']", { timeout: MAX_TIMEOUT });
            const code = await outlookPage.textContent("//*[contains(text(),'Your Proton verification code')]/following::span[string-length(normalize-space(text()))=6 and string-length(translate(normalize-space(text()), '0123456789', ''))=0]", { timeout: MAX_TIMEOUT });
            logger.info("收到验证邮件", code);
            await outlookPage.click("(//button[.//span[text()='Delete this message. (Delete)']])[1]");
            await outlookPage.goto("https://outlook.live.com/mail/0/");

            await protonPage.bringToFront();
            await protonPage.type("//input[@id='verification']", code);
            await protonPage.click("//button[text()='Verify']");
        }
        else {
            // 有时不能用邮箱验证
            logger.info("使用 CAPTCHA 验证");

            if (headless) {
                githubAnnotation('error', "无法自动验证");
                await screenshotAllPages();
                process.exit(1);
            }

            await protonPage.$x("//button[.//span[text()='CAPTCHA']]", { hidden: true, timeout: MAX_TIMEOUT });
        }

        await protonPage.click("//input[@id='understood-recovery-necessity']", { timeout: MAX_TIMEOUT });
        await protonPage.click("//button[text()='Continue' and not(@disabled)]");
        // Set a display name
        await protonPage.click("//button[text()='Continue']");
        // Welcome to Proton Mail
        await protonPage.click("//button[text()=\"Let's get started\"]", { timeout: MAX_TIMEOUT });
        await protonPage.click("//button[text()='Maybe later']");
        await protonPage.click("//button[text()='Next']");
        await protonPage.click("//button[text()='Use this']");

        await protonPage.goto("https://account.proton.me/u/0/mail/recovery");
        await protonPage.click("//a[text()='Safeguard account now']");
        await protonPage.click("//div[normalize-space(.)='Show more (2)']");
        await protonPage.click("//h2[text()='Add a recovery email address']");
        await protonPage.type("//input[@id='recovery-email-input']", outlookMail);
        await protonPage.click("//button[text()='Add email address']");
        await protonPage.type("//input[@id='password']", password);
        await protonPage.click("//button[text()='Authenticate']");

        logger.info("等待验证邮件");
        await outlookPage.bringToFront();
        await outlookPage.click("//span[text()='Proton Verification Code']", { timeout: MAX_TIMEOUT });
        const code = await outlookPage.textContent("//*[contains(text(),'Your Proton verification code')]/following::span[string-length(normalize-space(text()))=6 and string-length(translate(normalize-space(text()), '0123456789', ''))=0]", { timeout: MAX_TIMEOUT });
        logger.info("收到验证邮件", code);
        await outlookPage.click("(//button[.//span[text()='Delete this message. (Delete)']])[1]");
        await outlookPage.goto("https://outlook.live.com/mail/0/");

        await protonPage.bringToFront();
        for (let i = 0; i < 6; i++) {
            await protonPage.type(`//input[@aria-label='Enter verification code. Digit ${i + 1}.']`, code[i]);
        }
        await protonPage.click("//button[text()='Verify']");

        await protonPage.goto("https://mail.proton.me/u/0");
        logger.info("Proton Recovery 设置完成");

        logger.info([protonMail, password]);

        await protonPage.goto("https://account.proton.me/u/0/mail/account-password");
        await protonPage.click("//label[@for='twoFactorToggle']");
        await protonPage.type("//input[@id='password']", password);
        await protonPage.click("//button[text()='Authenticate']");
        await protonPage.click("//button[text()='Next']");

        await protonPage.click("//button[text()='Enter key manually instead']");
        const otpSecret = await protonPage.textContent("//code[@data-testid='totp:secret-key']");
        const otp = authenticator.generate(otpSecret);
        await protonPage.click("//button[text()='Next']");
        for (let i = 0; i < 6; i++) {
            await protonPage.type(`//input[@aria-label='Enter verification code. Digit ${i + 1}.']`, otp[i]);
        }
        await protonPage.click("//button[text()='Submit']");
        await protonPage.click("//button[text()='Close']");

        const data = JSON.stringify([protonMail.split('@')[0], password, otpSecret, new Date().toString()]);
        Utility.appendStepSummary(data);
        headless && process.exit();
        return;
    }

    const userMail = typeof protonMail != "undefined" ? protonMail : outlookMail;
    const mailPage = typeof protonPage != "undefined" ? protonPage : outlookPage;

    if (ENABLE_CHATGPT_REGISTER) {
        const page = await chrome.newPage();
        await page.goto("https://chatgpt.com/");
        await page.click("//button[contains(., 'Sign up for free')]");
        await page.waitForNavigation();

        await page.type("//input[@name='email']", userMail);
        await page.click("//button[text()='Continue']");
        await page.waitForNavigation();
        await page.type("//input[@name='new-password']", password);
        await page.click("//button[contains(., 'Continue')]");
        await page.waitForNavigation();

        logger.info("等待验证邮件", page.url());
        await mailPage.bringToFront();
        const text = await mailPage.textContent("//span[contains(., 'Your ChatGPT code is')]", { timeout: MAX_TIMEOUT });
        const code = text.match(/\b\d{6}\b/)[0];
        logger.info("收到验证邮件", code);

        await page.bringToFront();
        await page.type("//input[@name='code']", code);
        await page.click("//button[contains(., 'Continue')]");

        await page.type("//input[@placeholder='Full name']", userMail.split('@')[0].replace(/[^a-zA-Z]/g, ''));
        await page.type('//div[contains(@id,"-birthday")]//div[@contenteditable="true" and @data-type="month"]', String(Math.floor(Math.random() * 12) + 1));
        await page.type('//div[contains(@id,"-birthday")]//div[@contenteditable="true" and @data-type="day"]', String(Math.floor(Math.random() * 28) + 1));
        await page.type('//div[contains(@id,"-birthday")]//div[@contenteditable="true" and @data-type="year"]', String(1980 + Math.floor(Math.random() * 30)));
        await page.click("//button[contains(., 'Continue')]");
        await page.waitForNavigation();

        await page.goto("https://chatgpt.com/#settings/Security");
        await page.click("//button[@aria-label='Multi-factor authentication']");
        await page.click("//span[contains(., 'Trouble scanning?')]");
        const otpSecret = await page.textContent("//button[text()='Copy code']/preceding-sibling::div");
        await page.type("//input[@name='code']", authenticator.generate(otpSecret));
        await page.click("//button[contains(., 'Continue')]");
        await page.click("//input[@id='safelyRecorded']");
        await page.click("//button[contains(., 'Continue') and not(@disabled)]");

        const data = JSON.stringify([userMail, password, otpSecret, new Date().toString()]);
        Utility.appendStepSummary(data);
        headless && process.exit();
        return;
    }

    if (ENABLE_DENGTA_REGISTER) {

        {
            const data = JSON.stringify([userMail, password, new Date().toString()]);
            Utility.appendStepSummary(data);
            headless && process.exit();
            return;
        }

        // 获取灯塔 Cloud最新网址请发邮件至: dengtacloud@gmail.com
        const context = chrome.defaultBrowserContext();
        await context.overridePermissions("https://dengta.xn--xhq8sm16c5ls.com", ["clipboard-read", "clipboard-write"]);

        const page = await chrome.newPage();
        await page.goto("https://dengta.xn--xhq8sm16c5ls.com/#/register");
        await page.type("//input[@placeholder='邮箱']", userMail.split('@')[0]);
        await page.select("//select[@class='form-control form-control-alt']", "outlook.com");
        await page.click("//button[contains(.,'发送')]");

        await mailPage.bringToFront();
        await mailPage.goto("https://outlook.live.com/mail/0/junkemail");
        const text = await mailPage.textContent("//span[contains(text(),'您的验证码是')]", { timeout: MAX_TIMEOUT });
        const code = text.match(/\d{6}/)[0];
        logger.info("收到验证邮件", code);

        await page.bringToFront();
        await page.type("//input[@placeholder='邮箱验证码']", code);
        await page.type("(//input[@placeholder='密码'])[1]", password);
        await page.type("(//input[@placeholder='密码'])[2]", password);
        await page.click("//input[@type='checkbox']");
        await page.click("//button[contains(.,'注册')]");
        await page.waitForNavigation();

        logger.info([userMail, password]);

        await page.type("//input[@placeholder='邮箱']", userMail);
        await page.type("//input[@placeholder='密码']", password);
        await page.click("//button[contains(.,'登入')]");

        await page.click("//div[text()='一键订阅']");
        await page.click("//div[text()='复制订阅地址']");

        const url = await page.evaluate(() => navigator.clipboard.readText());

        const data = JSON.stringify([userMail, password, url, new Date().toString()]);
        Utility.appendStepSummary(data);
        headless && process.exit();
        return;
    }

    if (ENABLE_DOCKER_REGISTER) {
        const page = await chrome.newPage();
        await page.goto("https://app.docker.com/");
        await page.click("//a[@id='signup']");
        await page.waitForNavigation();
        // await page.click("//button[text()='Personal']");

        await page.type("//input[@name='email']", userMail);
        await page.type("//input[@name='username']", userMail.split('@')[0]);
        await page.type("//input[@name='password']", password);
        await page.click("//button[text()='Sign up' and not(@disabled)]");
        await page.waitForNavigation();

        // const data = JSON.stringify([userMail, password, otpSecret, new Date().toString()]);
        // Utility.appendStepSummary(data);
        headless && process.exit();
        return;
    }

    const firefox = os.platform() != 'linux' && await puppeteer.launch({
        browser: "firefox",
        headless,
        defaultViewport: null,
        protocolTimeout: MAX_TIMEOUT,
        slowMo: 10,
        devtools: true,
        args: [
            '--lang=en-US',
            '--width=1920', '--height=1080'
        ]
    });

    const page = (await firefox?.pages?.())?.[0] || await chrome.newPage();

    if (firefox) {
        logger.info(firefox.process().spawnfile, await firefox.version(), firefox.wsEndpoint());

        const viewportSize = await mailPage.evaluate(() => ({
            width: window.innerWidth,
            height: window.innerHeight
        }));

        await page.setViewport(viewportSize);
    }

    await page.goto("https://github.com/signup");
    await (await page.$x("//input[@placeholder='Email']")).type(userMail);
    await (await page.$x("//input[@placeholder='Password']")).type(password);
    const usernameElement = await page.$x("//input[@placeholder='Username']");
    await usernameElement.type(userMail.split('@')[0]);

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

    // await page.evaluate(() => {
    //     debugger;
    // });

    const frame = await page.waitForFrame(async frame => {
        if (frame.url() == "https://github.com/account_verifications")
            return true;

        if (await frame.$("//button[contains(., 'Visual puzzle')]"))
            return true;

        return false;
    }, { timeout: MAX_TIMEOUT });

    if (frame.url() != "https://github.com/account_verifications") {
        logger.info("需要验证", page.url());
        await frame.click("//button[contains(., 'Visual puzzle')]");

        if (headless) {
            githubAnnotation('error', "无法自动验证");
            await screenshotAllPages();
            process.exit(1);
        }

        await frame.waitForSelector("//button[contains(., 'Submit')]", { timeout: MAX_TIMEOUT });
        logger.info("等待验证真人");
        await page.waitForSelector("//h2[text()='Confirm your email address']", { timeout: MAX_TIMEOUT });
    }

    logger.info("等待验证邮件", page.url());
    await mailPage.bringToFront();
    await mailPage.click("//span[text()='🚀 Your GitHub launch code']", { timeout: MAX_TIMEOUT });
    logger.info("收到验证邮件");

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

    await (await page.$x("//button[@data-close-dialog-id='two-factor-setup-verification-mashed-secret']")).click();
    await (await page.$x("//input[@name='otp']")).type(authenticator.generate(otpSecret));

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

    const data = JSON.stringify([account, password, otpSecret, token.substring(4), new Date().toString()]);
    Utility.appendStepSummary(data);
    headless && process.exit();
})();