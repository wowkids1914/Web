import util from 'util';
import moment from 'moment';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { Awaitable, ClickOptions, ElementHandle, Frame, GoToOptions, HTTPResponse, KeyboardTypeOptions, NodeFor, Page, QueryOptions, ScreenshotOptions, WaitForNetworkIdleOptions, WaitForOptions, WaitForSelectorOptions, WaitTimeoutOptions } from 'puppeteer';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { STATUS_CODES } from 'http';
import logger from './logger.js';
import Utility from './Utility.js';

os.platform() != 'linux' && (process.exit = (code?: number | string) => undefined as never);

Date.prototype[util.inspect.custom] = function () {
    return moment(this).format('YYYY-MM-DD HH:mm:ss.SSS');
};

Date.prototype.toString = function () {
    return moment(this).format('YYYY-MM-DD HH:mm:ss.SSS');
};

const originalScreenshot = Page.prototype.screenshot;
Page.prototype.screenshot = function (this: Page, options?: Readonly<ScreenshotOptions>): Promise<Uint8Array> {
    if (options?.path) {
        const dir = path.dirname(options.path);
        fs.mkdirSync(dir, { recursive: true });
    }

    return originalScreenshot.call(this, options);
} as any;

const originalGoto = Page.prototype.goto;
Page.prototype.goto = async function (
    this: Page,
    url: string,
    options?: GoToOptions
): Promise<HTTPResponse | null> {
    let retries = options?.retries ?? 5;
    while (retries-- > 0) {
        try {
            const response = await originalGoto.call(this, url, options);
            if (response.ok())
                return response;

            logger.error(`goto ${url} ${response.status()} ${STATUS_CODES[response.status()]}`);
        }
        catch (e) {
            logger.error(`goto ${url} ${e.message}`);
        }

        await Utility.waitForSeconds(1);
    }
};

const originalWaitForNavigation = Page.prototype.waitForNavigation;
Page.prototype.waitForNavigation = async function (
    this: Page,
    options?: WaitForOptions
): Promise<HTTPResponse | null> {
    let count = 3;
    while (count-- > 0) {
        logger.info("⏳waitForNavigation", this.url());
        const response = await originalWaitForNavigation.call(this, options).then(() => {
            logger.info("✅waitForNavigation", this.url());
        }).catch(e => {
            logger.error(`❌waitForNavigation ${this.url()} ${(options && JSON.stringify(options)) ?? ""} ${e.message}`);
            return null;
        });

        if (!response || response.ok())
            return response;

        logger.error(`waitForNavigation ${this.url()} ${response.status()} ${STATUS_CODES[response.status()]}`);
        await this.reload();
    }
};

const originalWaitForNetworkIdle = Page.prototype.waitForNetworkIdle;
Page.prototype.waitForNetworkIdle = async function (
    this: Page,
    options?: WaitForNetworkIdleOptions
): Promise<void> {
    try {
        logger.info("⏳waitForNetworkIdle", this.url());
        return await originalWaitForNetworkIdle.call(this, { timeout: 10_000, ...options }).then(() => {
            logger.info("✅waitForNetworkIdle", this.url());
        });
    }
    catch (e) {
        logger.error(`❌waitForNetworkIdle ${this.url()} ${(options && JSON.stringify(options)) ?? ""} ${e.message}`);
    }
};

Frame.prototype.click = async function (
    this: Frame,
    selector: string,
    options?: Readonly<ClickOptions>
): Promise<void> {
    const handle = await this.waitForSelector(selector, options);
    return handle.click(options);
};

const originalType = Frame.prototype.type;
Frame.prototype.type = async function (
    this: Frame,
    selector: string,
    text: string,
    options?: Readonly<KeyboardTypeOptions>
): Promise<void> {
    selector = selector.startsWith("xpath=") ? selector : `xpath=${selector}`;
    await (await this.waitForSelector(selector)).click({ count: 3 });
    return originalType.call(this, selector, text, options);
};

Frame.prototype.waitForSelector = async function <Selector extends string>(
    this: Frame,
    selector: Selector,
    options?: WaitForSelectorOptions
): Promise<ElementHandle<NodeFor<Selector>> | null> {
    const config = { visible: true, timeout: 10_000, ...options };

    if (config.hidden)
        config.visible = false;

    const timeout = config.timeout ?? 10_000;
    const endTime = Date.now() + timeout;

    const page = this.page();
    const isMainFrame = page.mainFrame() == this;

    if (timeout >= 30_000)
        logger.info("waitForSelector", selector, (options && JSON.stringify(options)) ?? "");

    do {
        try {
            const elementHandle = await (isMainFrame ? page.mainFrame() : this).$(selector);
            if (elementHandle) {
                if (config.visible && await elementHandle.isVisible())
                    return elementHandle;

                if (config.hidden && await elementHandle.isHidden())
                    return elementHandle;

                if (!config.visible && !config.hidden)
                    return elementHandle;
            }
        }
        catch (e) {
            logger.info("waitForSelector", selector, (options && JSON.stringify(options)) ?? "", e.message);

            if (e.message?.includes('Execution context was destroyed'))
                continue;
        }

        if (Date.now() >= endTime)
            break;

        await Utility.waitForSeconds(0.2);
    } while (true);

    if (config.timeout)
        logger.error(`Waiting for selector \`${selector}\` failed: ${config.timeout}ms exceeded`);
};

const originalWaitForFrame = Page.prototype.waitForFrame;
Page.prototype.waitForFrame = function (
    this: Page,
    urlOrPredicate: string | ((frame: Frame) => Awaitable<boolean>),
    options?: WaitTimeoutOptions
): Promise<Frame> {
    return originalWaitForFrame.call(this, urlOrPredicate, options).catch(() => undefined);
};

const $ = Frame.prototype.$;
Frame.prototype.$ = function <Selector extends string>(
    this: Frame,
    selector: Selector,
    options?: WaitForSelectorOptions
): Promise<ElementHandle<NodeFor<Selector>> | null> {
    selector = selector.startsWith("xpath=") ? selector : `xpath=${selector}` as Selector;
    return $.call(this, selector, options);
};

const $$ = Frame.prototype.$$;
Frame.prototype.$$ = async function <Selector extends string>(
    this: Frame,
    selector: Selector,
    options?: QueryOptions
): Promise<Array<ElementHandle<NodeFor<Selector>>>> {
    selector = selector.startsWith("xpath=") ? selector : `xpath=${selector}` as Selector;

    if (options?.timeout)
        await this.waitForSelector(selector, options);

    return $$.call(this, selector, options);
};

Frame.prototype.$x = function <Selector extends string>(
    this: Frame,
    selector: Selector,
    options?: WaitForSelectorOptions
): Promise<ElementHandle<NodeFor<Selector>> | null> {
    return this.waitForSelector(selector, options);
};

Page.prototype.$x = function <Selector extends string>(
    this: Page,
    selector: Selector,
    options?: WaitForSelectorOptions
): Promise<ElementHandle<NodeFor<Selector>> | null> {
    return this.mainFrame().$x(selector, options);
};

Frame.prototype.textContent = async function <Selector extends string>(
    this: Frame,
    selector: Selector,
    options?: WaitForSelectorOptions
): Promise<string> {
    const el = await this.$x(selector, options);
    return el && this.evaluate(el => el.textContent.trim(), el);
};

Page.prototype.textContent = async function <Selector extends string>(
    this: Page,
    selector: Selector,
    options?: WaitForSelectorOptions
): Promise<string> {
    return this.mainFrame().textContent(selector, options);
};

const agent = os.platform() == 'linux' ? undefined : new SocksProxyAgent('socks5://127.0.0.1:10808');
const originalGet = axios.get;
axios.get = function <T = any, R = AxiosResponse<T>, D = any>(
    url: string,
    config?: AxiosRequestConfig<D>
): Promise<R> {
    const newConfig: AxiosRequestConfig<D> = {
        ...config,
        httpAgent: agent,
        httpsAgent: agent,
    };
    return originalGet.call(this, url, newConfig);
};