export interface JobValidation {
  passed: boolean;
  schemaPassed: boolean | null;
  testsPassed: number;
  testsFailed: number;
  messages: string[];
}

interface SummarizedJob {
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  validation: JobValidation | null;
}

export interface JobResultSummary {
  label: string;
  title: string;
  description: string;
  details: string[];
  action: string;
}

function explainValidationMessage(message: string): string {
  if (message.startsWith("acceptance_test_failed:")) {
    return `旧版验收规则未通过：${message.slice("acceptance_test_failed:".length)}`;
  }
  if (message.startsWith("equals_failed:")) {
    return `精确匹配未通过：${message.slice("equals_failed:".length)}`;
  }
  if (message.startsWith("contains_failed:")) {
    return `内容包含检查未通过：${message.slice("contains_failed:".length)}`;
  }
  if (message.startsWith("schema:")) {
    return `输出格式未通过 JSON Schema 检查：${message.slice("schema:".length)}`;
  }
  return message;
}

export function getJobResultSummary(job: SummarizedJob): JobResultSummary | null {
  if (job.status === "awaiting_approval") {
    return {
      label: "等待授权",
      title: "尚未开始执行",
      description: "这次调用选择了执行前确认，授权后才会进入队列",
      details: ["可写入本次隔离工作区并访问公开互联网"],
      action: "前往权限确认页面批准或拒绝",
    };
  }
  if (job.status === "failed" && job.errorCode === "validation_failed" && job.validation) {
    const details = job.validation.messages.map(explainValidationMessage);
    return {
      label: "规则检查失败",
      title: "输出不符合规则",
      description: "模型已经返回结果，但结果没有通过请求中声明的自动检查",
      details: details.length ? details : ["自动检查未通过，但没有返回具体说明"],
      action: "修改输入或验收规则后重新发起调用",
    };
  }
  if (job.status !== "failed") return null;
  return {
    label: "调用失败",
    title: "Codex 没有正常完成",
    description: job.errorMessage ?? "系统未返回具体原因",
    details: job.errorCode ? [`错误代码：${job.errorCode}`] : [],
    action: "检查错误后重新发起调用",
  };
}
