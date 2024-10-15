import { hasFilter } from "@calcom/features/filters/lib/hasFilter";
import { checkRateLimitAndThrowError } from "@calcom/lib/checkRateLimitAndThrowError";
import { EventTypeRepository } from "@calcom/lib/server/repository/eventType";
import type { PrismaClient } from "@calcom/prisma";
import { SchedulingType } from "@calcom/prisma/enums";

import type { TrpcSessionUser } from "../../../trpc";
import type { TGetEventTypesFromGroupSchema } from "./getByViewer.schema";
import { mapEventType } from "./util";

type GetByViewerOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
    prisma: PrismaClient;
  };
  input: TGetEventTypesFromGroupSchema;
};

type EventType = Awaited<ReturnType<typeof EventTypeRepository.findAllByUpId>>[number];
type MappedEventType = Awaited<ReturnType<typeof mapEventType>>;

export const getEventTypesFromGroup = async ({ ctx, input }: GetByViewerOptions) => {
  await checkRateLimitAndThrowError({
    identifier: `eventTypes:getEventTypesFromGroup:${ctx.user.id}`,
    rateLimitingType: "common",
  });

  const userProfile = ctx.user.profile;
  const { group, limit, cursor, filters } = input;
  const { teamId } = group;

  const isFilterSet = (filters && hasFilter(filters)) || !!teamId;
  const isUpIdInFilter = filters?.upIds?.includes(userProfile.upId);

  const shouldListUserEvents =
    !isFilterSet || isUpIdInFilter || (isFilterSet && filters?.upIds && !isUpIdInFilter);

  const eventTypes: MappedEventType[] = [];
  let currentCursor = cursor;
  let nextCursor: typeof cursor | undefined = undefined;

  const fetchAndFilterEventTypes = async () => {
    const batch = await fetchEventTypesBatch(ctx, input, shouldListUserEvents, currentCursor);
    const filteredBatch = filterEventTypes(batch.eventTypes, ctx.user.id, shouldListUserEvents, teamId);

    for (const eventType of filteredBatch) {
      if (eventTypes.length < limit) {
        eventTypes.push(eventType);
      } else {
        nextCursor = eventType.id;
        break;
      }
    }

    currentCursor = batch.nextCursor;
  };

  while (eventTypes.length < limit && currentCursor) {
    await fetchAndFilterEventTypes();
  }

  return {
    eventTypes,
    nextCursor,
  };
};

const fetchEventTypesBatch = async (
  ctx: GetByViewerOptions["ctx"],
  input: GetByViewerOptions["input"],
  shouldListUserEvents: boolean | undefined,
  cursor: typeof input.cursor
) => {
  const userProfile = ctx.user.profile;
  const { group, limit, filters } = input;
  const { teamId, parentId } = group;
  const isFilterSet = (filters && hasFilter(filters)) || !!teamId;

  const eventTypes: EventType[] = [];

  if (shouldListUserEvents || !teamId) {
    const userEventTypes =
      (await EventTypeRepository.findAllByUpId(
        {
          upId: userProfile.upId,
          userId: ctx.user.id,
        },
        {
          where: {
            teamId: null,
          },
          orderBy: [
            {
              position: "desc",
            },
            {
              id: "asc",
            },
          ],
          limit: limit + 1,
          cursor,
        }
      )) ?? [];

    eventTypes.push(...userEventTypes);
  }

  if (teamId) {
    const teamEventTypes =
      (await EventTypeRepository.findTeamEventTypes({
        teamId,
        parentId,
        userId: ctx.user.id,
        limit: limit + 1,
        cursor,
        where: {
          ...(isFilterSet && !!filters?.schedulingTypes
            ? {
                schedulingType: { in: filters.schedulingTypes },
              }
            : null),
        },
        orderBy: [
          {
            position: "desc",
          },
          {
            id: "asc",
          },
        ],
      })) ?? [];

    eventTypes.push(...teamEventTypes);
  }

  let nextCursor: typeof cursor | undefined = undefined;
  if (eventTypes.length > limit) {
    const nextItem = eventTypes.pop();
    nextCursor = nextItem?.id;
  }

  const mappedEventTypes = await Promise.all(eventTypes.map(mapEventType));

  return { eventTypes: mappedEventTypes, nextCursor };
};

const filterEventTypes = (
  eventTypes: MappedEventType[],
  userId: number,
  shouldListUserEvents: boolean | undefined,
  teamId: string | null
) => {
  let filteredEventTypes = eventTypes.filter((eventType) => {
    const isAChildEvent = eventType.parentId;
    if (!isAChildEvent) {
      return true;
    }
    // A child event only has one user
    const childEventAssignee = eventType.users[0];
    if (!childEventAssignee || childEventAssignee.id !== userId) {
      return false;
    }
    return true;
  });

  if (shouldListUserEvents || !teamId) {
    filteredEventTypes = filteredEventTypes.filter(
      (evType) => evType.schedulingType !== SchedulingType.MANAGED
    );
  }

  return filteredEventTypes;
};
