export const carrierDiagram = `flowchart TB
    P["12V DC電源"] --> C["中央の専用キャリアボード"]
    C ---|"SEAF8 ×2：信号・給電"| S["Comet A65 SOM"]
    C ---|"FMC ①"| A["CN0585 ①<br/>USB-C PD給電"]
    C ---|"FMC ②"| B["CN0585 ②<br/>USB-C PD給電"]
    A ---|"AFE接続・給電"| AF1["CN0584 ①"]
    B ---|"AFE接続・給電"| AF2["CN0584 ②"]
    C --- D["DIO回路・コネクタ"]`;

export const diagramExamples = {
  sequence: 'sequenceDiagram\n    participant User as ユーザー\n    participant AI\n    User->>AI: 依頼\n    AI-->>User: 回答',
  class: 'classDiagram\n    class Task {\n        +String title\n        +run()\n    }\n    Task --> Message',
  state: 'stateDiagram-v2\n    [*] --> Idle\n    Idle --> Running: 開始\n    Running --> [*]',
  er: 'erDiagram\n    TASK ||--o{ MESSAGE : contains\n    TASK {\n        string title\n    }',
  gantt: 'gantt\n    title 開発予定\n    dateFormat YYYY-MM-DD\n    section 実装\n    図の表示 :2026-10-02, 2d',
  pie: 'pie title タスクの状態\n    "完了" : 3\n    "作業中" : 1',
  mindmap: 'mindmap\n    root((プロジェクト))\n        UI\n        Tests',
  git: 'gitGraph\n    commit\n    branch feature\n    checkout feature\n    commit\n    checkout main\n    merge feature',
};
