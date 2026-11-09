import { CheckCircleFilled, CloseCircleOutlined, LoadingOutlined } from '@ant-design/icons';
import { Modal } from 'antd';
import { operatorLabel } from '../lib/assertions';
import type { TestCaseResult } from '../lib/testRunner';

interface TestRunModalProps {
  open: boolean;
  name: string;
  running: boolean;
  results: TestCaseResult[];
  onClose: () => void;
}

export function TestRunModal({ open, name, running, results, onClose }: TestRunModalProps) {
  const assertions = results.flatMap((item) => item.assertions);
  const passedAssertions = assertions.filter((item) => item.passed).length;
  const failedCases = results.filter(
    (item) => item.error || item.assertions.some((assertion) => !assertion.passed),
  ).length;
  const allPassed = failedCases === 0;

  return (
    <Modal
      open={open}
      title={`测试集 · ${name}`}
      footer={null}
      width={680}
      onCancel={onClose}
      destroyOnHidden
    >
      {running ? (
        <div className="testrun-running">
          <LoadingOutlined spin /> 正在按顺序运行集合内请求…
        </div>
      ) : (
        <div className="testrun-body">
          <div className={`testrun-summary${allPassed ? ' ok' : ' bad'}`}>
            <strong>
              {allPassed ? '全部通过' : `${failedCases} 个请求未通过`}
            </strong>
            <span>
              {results.length} 个请求 · {passedAssertions}/{assertions.length} 条断言通过
            </span>
          </div>

          {results.length === 0 && (
            <div className="testrun-empty">该集合暂无可运行的请求。</div>
          )}

          {results.map((item) => {
            const failed = item.error || item.assertions.some((assertion) => !assertion.passed);
            return (
              <div className={`testrun-case${failed ? ' bad' : ' ok'}`} key={item.id}>
                <div className="testrun-case-head">
                  <span className="testrun-state">
                    {failed ? <CloseCircleOutlined /> : <CheckCircleFilled />}
                  </span>
                  <span className="testrun-method">{item.method}</span>
                  <span className="testrun-name">{item.name}</span>
                  <span className="testrun-url mono">{item.url}</span>
                  {item.error ? (
                    <span className="testrun-meta bad">失败</span>
                  ) : (
                    <span className="testrun-meta">
                      {item.status} · {item.durationMs}ms
                    </span>
                  )}
                </div>

                {item.error && <div className="testrun-error">{item.error}</div>}

                {item.assertions.map((assertion) => (
                  <div
                    className={`assertion-result${assertion.passed ? ' ok' : ' bad'}`}
                    key={assertion.id}
                  >
                    <span className="assertion-state">
                      {assertion.passed ? <CheckCircleFilled /> : <CloseCircleOutlined />}
                    </span>
                    <span className="assertion-path mono">{assertion.path}</span>
                    <span className="assertion-op-label">
                      {operatorLabel(assertion.operator)}
                    </span>
                    <span className="assertion-expected mono">{assertion.expected || '—'}</span>
                    <span className="assertion-actual mono" title={assertion.actual}>
                      实际：{assertion.actual}
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
