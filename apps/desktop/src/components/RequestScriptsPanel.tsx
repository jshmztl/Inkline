interface RequestScriptsPanelProps {
  preScript: string;
  onPreScriptChange: (value: string) => void;
  postScript: string;
  onPostScriptChange: (value: string) => void;
}

/** 前置 / 后置脚本编辑器。 */
export function RequestScriptsPanel({
  preScript,
  onPreScriptChange,
  postScript,
  onPostScriptChange,
}: RequestScriptsPanelProps) {
  return (
    <div className="script-editor">
      <div className="script-block">
        <div className="script-head">
          <strong>前置脚本</strong>
          <span>发送前执行 · 可用于签名与写入变量</span>
        </div>
        <textarea
          className="code-block script-input"
          value={preScript}
          onChange={(event) => onPreScriptChange(event.target.value)}
          spellCheck={false}
          aria-label="前置脚本"
        />
      </div>
      <div className="script-block">
        <div className="script-head">
          <strong>后置脚本</strong>
          <span>收到响应后执行 · 可读取 pm.response</span>
        </div>
        <textarea
          className="code-block script-input"
          value={postScript}
          onChange={(event) => onPostScriptChange(event.target.value)}
          spellCheck={false}
          aria-label="后置脚本"
        />
      </div>
      <p className="script-tip">
        沙箱内可用 <code>pm.variables.get/set/unset</code>、
        <code>pm.request</code>、<code>pm.response.status/body/json()</code> 与{' '}
        <code>console.log</code>。执行结果见响应区「Console」，超时 2 秒强制终止。
      </p>
    </div>
  );
}
