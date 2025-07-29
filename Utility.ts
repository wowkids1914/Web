import fs from 'fs';
import { Mouse } from "puppeteer";
import logger from './logger.js';

export default class Utility {
    static async waitForSeconds(delay: number) {
        return new Promise((resolve, reject) => {
            setTimeout(() => {
                resolve(null);
            }, Math.min(delay * 1000, Math.pow(2, 31) - 1));
        });
    }

    /**
     * Node 端实现的 waitForFunction，用于轮询等待某个异步条件成立
     * @param conditionFn - 返回你需要的值，不满足时返回 null/undefined
     * @param options - 轮询间隔和超时时间
     * @returns Promise<any>
     */
    static async waitForFunction<T>(
        conditionFn: () => Promise<T | null | undefined>,
        options: { pollInterval?: number; timeout?: number } = {}
    ): Promise<T> {
        const { pollInterval = 300, timeout = 300_000 } = options;
        const start = Date.now();

        while (true) {
            const result = await conditionFn();
            if (result !== null && result !== undefined)
                return result;

            if (Date.now() - start > timeout)
                throw new Error('waitForFunction timeout');

            await this.waitForSeconds(pollInterval / 1000);
        }
    }

    static appendStepSummary(data: string, logFunc: (_: string) => void = logger.info) {
        const { GITHUB_STEP_SUMMARY } = process.env;
        data = typeof data == "string" ? data : JSON.stringify(data, null, 4);
        GITHUB_STEP_SUMMARY && fs.appendFileSync(GITHUB_STEP_SUMMARY, data + "\n");
        logFunc(data);
    }

    static async humanLikeMouseMove(
        mouse: Mouse,
        from: { x: number, y: number },
        to: { x: number, y: number },
        steps = 40
    ) {
        const { x: startX, y: startY } = from;
        const { x: endX, y: endY } = to;

        // 使用二次贝塞尔曲线，增加中间控制点的偏移量
        const cx = startX + (endX - startX) / 2 + (Math.random() - 0.5) * 80;
        const cy = startY + (endY - startY) / 2 + (Math.random() - 0.5) * 80;

        for (let i = 1; i <= steps; i++) {
            // easeInOutQuad缓动
            let t = i / steps;
            t = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

            // 二次贝塞尔曲线
            const x =
                (1 - t) * (1 - t) * startX +
                2 * (1 - t) * t * cx +
                t * t * endX +
                (Math.random() - 0.5) * 1.2; // 轻微抖动
            const y =
                (1 - t) * (1 - t) * startY +
                2 * (1 - t) * t * cy +
                t * t * endY +
                (Math.random() - 0.5) * 1.2;

            await mouse.move(x, y);

            // 间隔时间模拟加速减速
            const baseDelay = 5 + 15 * (1 - Math.cos(Math.PI * t)) / 2;
            const jitter = Math.random() * 6;
            await new Promise(r => setTimeout(r, baseDelay + jitter));

            // 偶尔小停顿
            if (Math.random() < 0.02) {
                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
            }
        }
    }
}