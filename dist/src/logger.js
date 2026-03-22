import { pino } from "pino";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
// 使用系统临时目录，确保跨平台兼容性
const logDir = path.join(os.tmpdir(), "google-search-logs");
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}
// 创建日志文件路径
const logFilePath = path.join(logDir, "google-search.log");
// 创建pino日志实例
const logger = pino({
    level: process.env.LOG_LEVEL || "info", // 可通过环境变量设置日志级别
    transport: {
        targets: [
            // 输出到控制台，使用pino-pretty美化输出
            {
                target: "pino-pretty",
                level: "info",
                options: {
                    colorize: true,
                    translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
                    ignore: "pid,hostname",
                },
            },
            // 输出到文件 - 使用trace级别确保捕获所有日志
            {
                target: "pino/file",
                level: "trace", // 使用最低级别以捕获所有日志
                options: { destination: logFilePath },
            },
        ],
    },
});
// 添加进程退出时的处理
process.on("exit", () => {
    logger.info("Process exiting, shutting down logger.");
});
process.on("SIGINT", () => {
    logger.info("Received SIGINT, shutting down logger.");
    process.exit(0);
});
process.on("SIGTERM", () => {
    logger.info("Received SIGTERM, shutting down logger.");
    process.exit(0);
});
process.on("uncaughtException", (error) => {
    logger.error({ err: error }, "Uncaught exception.");
    process.exit(1);
});
export default logger;
//# sourceMappingURL=logger.js.map