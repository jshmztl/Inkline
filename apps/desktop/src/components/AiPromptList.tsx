import { App } from 'antd';
import { Prompts } from '@ant-design/x';

const promptLabels = ['从文档生成接口', '生成接口文档', '补全字段说明', '生成测试用例', '解释错误'];

interface AiPromptListProps {
  composer: string;
  onCompose: (text: string) => void;
  onGenerateFromDoc: (text: string) => void;
  onGenerateDoc: () => void;
  onFillDescriptions: () => void;
  onGenerateTests: () => void;
}

// 常用提示词快捷入口。
export function AiPromptList({
  composer,
  onCompose,
  onGenerateFromDoc,
  onGenerateDoc,
  onFillDescriptions,
  onGenerateTests,
}: AiPromptListProps) {
  const { message } = App.useApp();

  function handleSelect(label: string) {
    if (label === '从文档生成接口') {
      const text = composer.trim();
      if (!text) {
        message.info('把 Word 里的接口信息粘贴到输入框，再点「生成接口」或直接发送。');
        return;
      }
      onCompose('');
      onGenerateFromDoc(text);
      return;
    }
    if (label === '生成接口文档') {
      onGenerateDoc();
      return;
    }
    if (label === '补全字段说明') {
      onFillDescriptions();
      return;
    }
    if (label === '生成测试用例') {
      onGenerateTests();
      return;
    }
    onCompose(
      label === '解释错误'
        ? '请结合当前接口上下文，解释最近一次请求失败的可能原因和排查步骤。'
        : label,
    );
  }

  return (
    <Prompts
      className="ai-prompts"
      items={promptLabels.map((label) => ({ key: label, label }))}
      wrap
      onItemClick={({ data }) => handleSelect(String(data.label ?? ''))}
    />
  );
}
