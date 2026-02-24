import { ChatModerationAction, prisma } from '@hctv/db';
import type {
  ChatModerationCommand,
  ChatRestrictionState,
  ChatSocket,
  ChatUser,
} from '../types/chat.js';

type ModerationContext = {
  chatUser: ChatUser;
  targetUsername: string;
  channelId: string;
};

type DeleteMessageDeps = {
  deleteMessageFromHistory: (targetUsername: string, msgId: string) => Promise<boolean>;
  logModerationEvent: (payload: {
    action: ChatModerationAction;
    channelId: string;
    moderatorId: string;
    targetUserId?: string;
    reason?: string;
    details?: Record<string, unknown>;
  }) => Promise<void>;
  broadcastToChannel: (
    targetUsername: string,
    ws: ChatSocket,
    payload: Record<string, unknown>
  ) => void;
};

type UserRestrictionDeps = {
  logModerationEvent: (payload: {
    action: ChatModerationAction;
    channelId: string;
    moderatorId: string;
    targetUserId?: string;
    reason?: string;
    details?: Record<string, unknown>;
  }) => Promise<void>;
  broadcastRestrictionStateToUser: (
    targetUsername: string,
    targetUserId: string,
    channelId: string,
    ws: ChatSocket
  ) => Promise<void>;
  broadcastToChannel: (
    targetUsername: string,
    ws: ChatSocket,
    payload: Record<string, unknown>
  ) => void;
};

export function sendModerationError(
  socket: ChatSocket,
  code: string,
  message: string,
  restriction?: ChatRestrictionState
) {
  socket.send(
    JSON.stringify({
      type: 'moderationError',
      code,
      message,
      restriction,
    })
  );
}

function requireModerationContext(
  socket: ChatSocket,
  socketState: ChatSocket
): ModerationContext | null {
  if (
    !socketState.isModerator ||
    !socketState.chatUser ||
    !socketState.targetUsername ||
    !socketState.channelId
  ) {
    sendModerationError(socket, 'FORBIDDEN', 'You do not have permission to moderate this chat.');
    return null;
  }

  return {
    chatUser: socketState.chatUser,
    targetUsername: socketState.targetUsername,
    channelId: socketState.channelId,
  };
}

async function resolveModerationTarget(
  socket: ChatSocket,
  actingModeratorUserId: string,
  rawTargetUserId: unknown
) {
  const targetUserId = typeof rawTargetUserId === 'string' ? rawTargetUserId : '';

  if (!targetUserId || targetUserId === actingModeratorUserId) {
    sendModerationError(socket, 'INVALID_TARGET', 'Invalid moderation target.');
    return null;
  }

  const targetUserRecord = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: {
      isAdmin: true,
      personalChannel: { select: { name: true } },
    },
  });

  if (!targetUserRecord) {
    sendModerationError(socket, 'INVALID_TARGET', 'Target user no longer exists.');
    return null;
  }

  return {
    targetUserId,
    targetUserRecord,
    resolvedTargetUsername: targetUserRecord.personalChannel?.name ?? 'that user',
  };
}

async function ensureAdminTargetModerationAllowed(
  socket: ChatSocket,
  actingModeratorUserId: string,
  targetIsAdmin: boolean
) {
  if (process.env.NODE_ENV !== 'production' || !targetIsAdmin) {
    return true;
  }

  const actingUserRecord = await prisma.user.findUnique({
    where: { id: actingModeratorUserId },
    select: { isAdmin: true },
  });

  if (!actingUserRecord?.isAdmin) {
    sendModerationError(
      socket,
      'FORBIDDEN',
      'Platform admins cannot be moderated via chat commands.'
    );
    return false;
  }

  return true;
}

export async function handleDeleteMessageCommand(
  socket: ChatSocket,
  socketState: ChatSocket,
  msg: ChatModerationCommand,
  deps: DeleteMessageDeps
) {
  const context = requireModerationContext(socket, socketState);
  if (!context) {
    return;
  }

  const msgId = typeof msg.msgId === 'string' ? msg.msgId : '';
  if (!msgId) {
    sendModerationError(socket, 'INVALID_REQUEST', 'Invalid message id.');
    return;
  }

  const deleted = await deps.deleteMessageFromHistory(context.targetUsername, msgId);
  if (!deleted) {
    sendModerationError(socket, 'NOT_FOUND', 'Message not found.');
    return;
  }

  await deps.logModerationEvent({
    action: ChatModerationAction.MESSAGE_DELETED,
    channelId: context.channelId,
    moderatorId: context.chatUser.moderatorUserId,
    reason: 'Message deleted by moderator',
    details: { msgId },
  });

  deps.broadcastToChannel(context.targetUsername, socket, { type: 'messageDeleted', msgId });
}

export async function handleUserRestrictionCommand(
  socket: ChatSocket,
  socketState: ChatSocket,
  msg: ChatModerationCommand,
  deps: UserRestrictionDeps
) {
  const context = requireModerationContext(socket, socketState);
  if (!context) {
    return;
  }

  const actingModeratorUserId = context.chatUser.moderatorUserId;
  const target = await resolveModerationTarget(socket, actingModeratorUserId, msg.targetUserId);
  if (!target) {
    return;
  }

  const canModerateTarget = await ensureAdminTargetModerationAllowed(
    socket,
    actingModeratorUserId,
    target.targetUserRecord.isAdmin
  );
  if (!canModerateTarget) {
    return;
  }

  if (msg.type === 'mod:unbanUser' || msg.type === 'mod:liftTimeout') {
    await prisma.chatUserBan.deleteMany({
      where: {
        channelId: context.channelId,
        userId: target.targetUserId,
      },
    });

    await deps.logModerationEvent({
      action: ChatModerationAction.USER_UNBANNED,
      channelId: context.channelId,
      moderatorId: actingModeratorUserId,
      targetUserId: target.targetUserId,
      reason: 'User unbanned in chat',
    });

    await deps.broadcastRestrictionStateToUser(
      context.targetUsername,
      target.targetUserId,
      context.channelId,
      socket
    );

    deps.broadcastToChannel(context.targetUsername, socket, {
      type: 'systemMsg',
      message: `${target.resolvedTargetUsername} can chat again.`,
    });
    return;
  }

  const reason =
    typeof msg.reason === 'string' && msg.reason.trim().length > 0
      ? msg.reason.trim().slice(0, 250)
      : msg.type === 'mod:timeoutUser'
        ? 'Timed out by moderator'
        : 'Banned by moderator';
  const durationSeconds =
    msg.type === 'mod:timeoutUser'
      ? Math.min(Math.max(Number(msg.durationSeconds) || 300, 10), 60 * 60 * 24)
      : null;
  const expiresAt = durationSeconds ? new Date(Date.now() + durationSeconds * 1000) : null;

  await prisma.chatUserBan.upsert({
    where: {
      channelId_userId: {
        channelId: context.channelId,
        userId: target.targetUserId,
      },
    },
    create: {
      channelId: context.channelId,
      userId: target.targetUserId,
      bannedById: actingModeratorUserId,
      reason,
      expiresAt,
    },
    update: {
      bannedById: actingModeratorUserId,
      reason,
      expiresAt,
    },
  });

  await deps.logModerationEvent({
    action:
      msg.type === 'mod:timeoutUser'
        ? ChatModerationAction.USER_TIMEOUT
        : ChatModerationAction.USER_BANNED,
    channelId: context.channelId,
    moderatorId: actingModeratorUserId,
    targetUserId: target.targetUserId,
    reason,
    details: durationSeconds ? { durationSeconds } : undefined,
  });

  await deps.broadcastRestrictionStateToUser(
    context.targetUsername,
    target.targetUserId,
    context.channelId,
    socket
  );

  deps.broadcastToChannel(context.targetUsername, socket, {
    type: 'systemMsg',
    message:
      msg.type === 'mod:timeoutUser'
        ? `${target.resolvedTargetUsername} was timed out for ${durationSeconds}s.`
        : `${target.resolvedTargetUsername} was banned.`,
  });
}
