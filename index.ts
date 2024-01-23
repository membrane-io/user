// `nodes` contain any nodes you add from the graph (dependencies)
// `root` is a reference to this program's root node
// `state` is an object that persists across program updates. Store data here.
import { nodes, root, state } from "membrane";

state.nextThreadId = state.nextThreadId ?? 1;
state.nextMessageId = state.nextMessageId ?? 1;
state.seenId = state.seenId ?? 0;
state.unanswered = state.unanswered ?? {};
state.messages = state.messages ?? [];
state.threads = state.threads ?? {};
state.threadsByChannel = state.threadsByChannel ?? new Map();

const unanswered: Record<number, Question> = state.unanswered;
const messages: Message[] = state.messages;
const threads: Record<number, Thread> = state.threads;
const threadsByChannel: Map<any, Thread> = state.threadsByChannel;

type Thread = {
  id: number;
  name: string;
  channel: Channel;
  messages: Message[];
  readUpTo: number;
};

type Tell = {
  id: number;
  threadId: number;
  receivedAt: Date;
  message: string;
  node: any;
  outbound?: boolean;
};

type Question = {
  id: number;
  threadId: number;
  receivedAt: Date;
  question: string;
  node: any;
  resolve?: (response: string) => void;
  reject?: (e: Error) => void;
  responseId?: number;
};

type Response = {
  id: number;
  threadId: number;
  receivedAt: Date;
  response: string;
};

type Message = Tell | Question | Response;

export async function tell({ message, node, channel }) {
  const thread = await threadForChannel(channel);
  const id = state.nextMessageId++;
  const msg = {
    id,
    threadId: thread.id,
    message,
    node,
    receivedAt: new Date(),
  };
  messages.push(msg);
  thread.messages.push(msg);

  console.log(`Message ${id}: ${message}`);
  await sendEmail(`Message from Membrane`, message);
}

export async function ask({ question, node, channel }) {
  const thread = await threadForChannel(channel);

  const id = state.nextMessageId++;
  const promise = new Promise((resolve, reject) => {
    const msg = {
      id,
      threadId: thread.id,
      receivedAt: new Date(),
      question,
      node,
      resolve,
      reject,
    };
    messages.push(msg);
    thread.messages.push(msg);
    unanswered[id] = msg;

    sendEmail(`Question #${id} from Membrane`, question).catch((e) => {
      reject(e);
    });
  });

  console.log(`Question ${id}: ${question}`);

  // Wait for an answer
  return await promise;
}

/// Here you can specify how you'd like to receive questions and messages from programs.
/// By default, you'll get messages via email.
/// If you use a mechanism that doesn't support both subjects and bodies, you can concatenate them.
async function sendEmail(subject: string, body: string) {
  // INSTRUCTIONS: uncomment this to also receive messages and questions via email
  // await nodes.email.send({
  //   subject,
  //   body,
  // });
}

/// Handles email responses which are used to answer questions
export async function email({ subject, replyText, text }) {
  const match = subject.match(/Question #(\d+)/);
  if (!match) {
    return;
  }
  const id = parseInt(match[1]);
  resolveQuestion(id, replyText ?? text);
}

export const Root = {
  name: () => "User",
  threads: () => ({}),
  messages: () => ({}),
  unreadCount: (_) => {
    let count = 0;
    for (const thread of Object.values(threads)) {
      count += thread.messages.length - (thread.readUpTo ?? 0);
    }
    return count;
  },
  unansweredCount: () => Object.keys(state.unanswered).length,
  markRead: (_, { self }) => {
    for (const thread of Object.values(threads)) {
      thread.readUpTo = thread.messages.length;
    }
  },
};

export const Thread = {
  gref: (_, { obj }) => root.threads.one({ id: obj.id }),
  unreadCount: (_, { obj }) => obj.messages.length - (obj.readUpTo ?? 0),
  unansweredCount: () => Object.keys(state.unanswered).length,
  tell: async ({ message, node }, { self }) => {
    const threadId = self.$argsAt(root.threads.one).id;
    const thread = threads[threadId];
    const msg = {
      id: state.nextMessageId++,
      threadId,
      receivedAt: new Date(),
      message,
      node,
      outbound: true,
    };
    messages.push(msg);
    thread.messages.push(msg);
    await thread.channel?.tell({ message });
  },
  markRead: (_, { self }) => {
    const threadId = self.$argsAt(root.threads.one).id;
    const thread = threads[threadId];
    thread.readUpTo = thread.messages.length;
  },
};

export const ThreadCollection = {
  one: ({ id }) => threads[id],
  page: (args, { self }) => {
    const page = args.page ?? 0;
    const pageSize = args.pageSize ?? 12;
    const all = Object.values(threads);
    const start = page * pageSize;
    const end = (page + 1) * pageSize;
    const items = all.slice(start, end);
    const next = all.length > end ? self.page({ page, pageSize }) : null;
    return { items, next };
  },
};

export const Message = {
  gref: (_, { obj }) => {
    return root.threads.one({ id: obj.threadId }).messages.one({ id: obj.id });
  },
  /// This can be used to respond to a question directly but more generally
  /// you'll want to use your messaging mechanism (e.g. email)
  respond: ({ text }, { self }) => {
    const id = self.$argsAt(root.threads.one.messages.one).id;
    resolveQuestion(id, text);
  },
  text: (_, { obj }) => obj.message ?? obj.question ?? obj.response,
  kind: (_, { obj }) =>
    obj.message
      ? obj.outbound
        ? "tell-out"
        : "tell"
      : obj.question
      ? "question"
      : "response",
  pending: (_, { obj }) => !!(obj.question && !obj.responseId),
  channel: (_, { obj }) => threads[obj.threadId].channel?.toJSON(),
};

export const MessageCollection = {
  one: ({ id }, { self }) => {
    let list = messages;
    if (!self.$matchesExact(root.messages)) {
      const threadId = self.$argsAt(root.threads.one).id;
      list = threads[threadId].messages;
    }
    const msg = list[binarySearch(id, list)];
    if (msg?.id === id) {
      return msg;
    }
  },
  page: ({ before, pageSize }, { self }) => {
    let list = messages;
    let threadId;
    if (!self.$matchesExact(root.messages)) {
      threadId = self.$argsAt(root.threads.one).id;
      list = threads[threadId].messages;
    }
    // const threadId = self.$argsAt(root.threads.one).id;
    // const thread = threads[threadId];
    const size = pageSize ?? 12;
    let startIndex: number;
    let endIndex: number;
    if (before) {
      endIndex = binarySearch(before, list);
      startIndex = Math.max(endIndex - size, 0);
    } else {
      endIndex = list.length;
      startIndex = Math.max(list.length - size, 0);
    }
    const items = list.slice(startIndex, endIndex);

    let next;
    if (threadId) {
      next =
        startIndex > 0
          ? root.threads
              .one({ id: threadId })
              .messages.page({ before: items[0].id, pageSize })
          : null;
    } else {
      next =
        startIndex > 0
          ? root.messages.page({ before: items[0].id, pageSize })
          : null;
    }

    return {
      items,
      next,
    };
  },
};

function resolveQuestion(id: number, text: any) {
  const question = unanswered[id];
  if (!question) {
    throw new Error(
      `No question found with id ${id}. Perhaps it was already answered.`
    );
  }
  if (question.responseId || !question.resolve) {
    throw new Error(`Question #${question.id} already answered`);
  }
  if (typeof question.question === undefined) {
    throw new Error(`Message #${question.id} is not a question`);
  }
  question.resolve(text);
  question.responseId = state.nextMessageId++;
  const thread = threads[question.threadId];
  const response = {
    id: question.responseId,
    threadId: question.threadId,
    receivedAt: new Date(),
    response: text,
  };
  messages.push(response);
  thread.messages.push(response);
  delete unanswered[question.id];
  delete question.resolve;
  delete question.reject;
}

/// Get or create the thread that corresponds to a channel. A channel is a gref passed to ask/tell that
/// provides a way to send messages other than "ask" responses.
async function threadForChannel(channel: Channel) {
  let thread = threadsByChannel.get(channel ?? null);
  if (!thread) {
    const id = state.nextThreadId++;
    const name = channel ? await channel.name : "Default thread";
    thread = { id, channel, name, messages: [], readUpTo: 0 };
    threadsByChannel.set(channel ?? null, thread);
    threads[id] = thread;
  }
  return thread;
}

// Binary search for the first message with id <= before
function binarySearch(id: number, list: Message[]): number {
  let low = 0;
  let high = list.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (list[mid].id > id) {
      high = mid - 1;
    } else if (list[mid].id < id) {
      low = mid + 1;
    } else {
      return mid;
    }
  }
  return low;
}
