interface TaskErrorMessageProps {
  message: string;
  summary: string;
  role?: 'alert' | 'status';
}

/** Keep task lists readable while retaining the complete diagnostic for review. */
export function TaskErrorMessage({ message, summary, role }: TaskErrorMessageProps) {
  const isLong = message.length > 160 || message.split('\n').length > 3;
  if (!isLong) return <p className="whitespace-pre-wrap [overflow-wrap:anywhere]" role={role}>{message}</p>;
  return (
    <div className="[overflow-wrap:anywhere]" data-task-error>
      <p role={role}>{summary}</p>
      <details>
        <summary className="min-h-11 w-fit cursor-pointer py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">查看错误详情</summary>
        <div aria-label="错误详情全文" className="max-h-40 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" role="region" tabIndex={0}>{message}</div>
      </details>
    </div>
  );
}
