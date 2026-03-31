/**
 * Global in-memory index — shared between index.ts and registry.ts to avoid circular deps.
 */

export type EdgeType =
    | 'call'             // 普通函数调用
    | 'jsx'              // JSX 组件渲染 <Component />
    | 'new'              // new ClassName() 实例化
    | 'event_emit'       // callbacks.run('X') / AppEvents.emit('X')
    | 'event_listen'     // callbacks.add('X', handler) — 通过虚拟节点 X 连接
    | 'pubsub_publish'   // Meteor.publish('name', fn)
    | 'pubsub_subscribe' // Meteor.subscribe('name')
    | 'type';            // TypeScript 类型注解引用 (chat: ChatAPI)

export interface CallEdge {
    name: string;
    edgeType: EdgeType;
    /** event_listen 时：对应的事件名（用于在 index 中建虚拟边） */
    event?: string;
}

export interface CallerRef {
    caller: string;
    file: string;
    edgeType: EdgeType;
}

export const GLOBAL_INDEX = {
    symbols:        new Map<string, Set<string>>(),                    // symbol name -> definition file paths
    fileDependents: new Map<string, Set<string>>(),                    // file -> files that import it (reverse)
    allFiles:       new Set<string>(),
    callGraph:      new Map<string, Array<CallerRef>>(),               // callee/event -> [{caller, file, edgeType}]
    embeddings:     new Map<string, number[]>(),                       // `${symbolName}@${filePath}` -> vector
};
