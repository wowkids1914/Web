import { Mouse } from "puppeteer";

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

    static async humanLikeMouseMove(mouse: Mouse, from: { x: number, y: number }, to: { x: number, y: number }, steps = 30) {
        const { x: startX, y: startY } = from;
        const { x: endX, y: endY } = to;
        for (let i = 1; i <= steps; i++) {
            const progress = i / steps;
            // 贝塞尔曲线或简单插值
            const x = startX + (endX - startX) * progress + (Math.random() - 0.5) * 2;
            const y = startY + (endY - startY) * progress + (Math.random() - 0.5) * 2;
            await mouse.move(x, y);
            await new Promise(r => setTimeout(r, Math.random() * 10 + 5)); // 随机延迟
        }
    }
}