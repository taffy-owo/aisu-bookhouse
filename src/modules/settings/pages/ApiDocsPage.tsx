import { Activity, ExternalLink, FileText } from 'lucide-react';

const DOC_LINKS = [
  {
    description: '失败任务接管、外部译文续更、原文件与在线目录核验，以及旧任务对账。',
    href: '/api-external-workflow.md',
    icon: FileText,
    title: '外部翻译接入指南',
  },
  {
    description: '查看原文抓取、译文提交、项目进度和入库核验的完整接口定义。',
    href: '/api/v1/openapi.json',
    icon: FileText,
    title: 'OpenAPI 接口定义',
  },
  {
    description: '查看当前服务、数据库和存储的实时状态。',
    href: '/api/v1/ready',
    icon: Activity,
    title: '服务状态',
  },
] as const;

export function ApiDocsPage() {
  return (
    <section className="mx-auto w-full max-w-[980px]">
      <header className="border-b border-ink/10 pb-4 dark:border-white/10">
        <h1 className="app-page-title font-display text-3xl sm:text-4xl font-semibold text-stone-950 dark:text-night-ink">API 文档</h1>
        <p className="mt-3 max-w-2xl text-sm leading-7 text-stone-500 dark:text-stone-400">
          原文抓取、译文提交、项目进度和入库核验的 API 文档。
        </p>
      </header>

      <div className="mt-4 divide-y divide-ink/10 dark:divide-white/10">
        {DOC_LINKS.map((item) => {
          const Icon = item.icon;

          return (
            <a
              className="group flex items-center gap-4 py-4 transition-colors hover:text-accent dark:hover:text-accent-soft"
              href={item.href}
              key={item.title}
              rel="noreferrer"
              target="_blank"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-white/55 text-accent shadow-soft dark:bg-white/[0.06] dark:text-accent-soft">
                <Icon className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-base font-semibold text-stone-900 dark:text-night-ink">{item.title}</span>
                <span className="mt-1 block text-sm leading-6 text-stone-500 dark:text-stone-400">{item.description}</span>
              </span>
              <ExternalLink className="h-4 w-4 shrink-0 text-stone-400 transition-transform group-hover:translate-x-0.5 group-hover:text-accent dark:text-stone-500 dark:group-hover:text-accent-soft" />
            </a>
          );
        })}
      </div>
    </section>
  );
}
