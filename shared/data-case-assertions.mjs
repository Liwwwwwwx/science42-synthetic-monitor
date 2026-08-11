// 数据建模的产品文案会随任务模板演进；验收的是两个业务阶段，而不是某一版完整转录。
export const DATA_FLOW_STAGES = [
  {
    key: 'planning',
    label: '建模方案',
    signals: [
      '正在构思装配结构规划',
      '正在分析装配需求并生成建模方案',
      '建模方案思考完成',
    ],
  },
  {
    key: 'geometry',
    label: '几何实体生成',
    signals: [
      '正在生成几何实体，请稍候',
      '生成几何实体',
    ],
  },
];

// 支持聊天原文、生成文件 JSON 和渲染后的查看器文本；\b 可覆盖 `file.stl",` 等结构化边界。
const STL_ARTIFACT_RE = /\.stl\b|<<<STL_VIEWER:|STL 模型|>STL<|STL_VIEWER/i;

export function collectDataFlowStages(content) {
  const text = String(content || '');
  return DATA_FLOW_STAGES
    .filter((stage) => stage.signals.some((signal) => text.includes(signal)))
    .map((stage) => stage.key);
}

export function hasStlArtifact(content) {
  return STL_ARTIFACT_RE.test(String(content || ''));
}

export function isDataCaseComplete(seenStages, stlSeen) {
  return DATA_FLOW_STAGES.every((stage) => seenStages.has(stage.key)) && stlSeen;
}

export function missingDataFlowStages(seenStages) {
  return DATA_FLOW_STAGES.filter((stage) => !seenStages.has(stage.key));
}

export function dataCaseFailureReason(seenStages, stlSeen) {
  const missingStages = missingDataFlowStages(seenStages).map((stage) => stage.label);
  const missing = [
    ...(missingStages.length ? [`缺少流程信号：${missingStages.join('、')}`] : []),
    ...(!stlSeen ? ['未检测到 STL 文件产物'] : []),
  ];
  return missing.join('；') || '数据建模验收条件未满足';
}
