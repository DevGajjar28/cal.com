import type { Prisma } from "@prisma/client";

import type { CredentialOwner } from "@calcom/app-store/types";
import checkAppSetupStatus from "@calcom/lib/apps/checkAppSetupStatus";
import constructUserTeams from "@calcom/lib/apps/constructUserTeams";
import getAppDependencyData from "@calcom/lib/apps/getAppDependencyData";
import getEnabledAppsFromCredentials from "@calcom/lib/apps/getEnabledAppsFromCredentials";
import getInstallCountPerApp from "@calcom/lib/apps/getInstallCountPerApp";
import getTeamAppCredentials from "@calcom/lib/apps/getTeamAppCredentials";
import getUserAvailableTeams from "@calcom/lib/apps/getUserAvailableTeams";
import { getUsersCredentials } from "@calcom/lib/server/getUsersCredentials";
import type { TrpcSessionUser } from "@calcom/trpc/server/trpc";

import type { TIntegrationsInputSchema } from "./integrations.schema";

type IntegrationsOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TIntegrationsInputSchema;
};

export type TeamQuery = Prisma.TeamGetPayload<{
  select: {
    id: true;
    credentials: {
      select: typeof import("@calcom/prisma/selects/credential").credentialForCalendarServiceSelect;
    };
    name: true;
    logoUrl: true;
    members: {
      select: {
        role: true;
      };
    };
  };
}>;

export const integrationsHandler = async ({ ctx, input }: IntegrationsOptions) => {
  const { user } = ctx;
  const {
    variant,
    exclude,
    onlyInstalled,
    includeTeamInstalledApps,
    extendsFeature,
    teamId,
    sortByMostPopular,
    appId,
  } = input;
  const isUserPartOfTeam = includeTeamInstalledApps || teamId;

  let credentials = await getUsersCredentials(user);
  let userTeams: TeamQuery[] = [];

  if (isUserPartOfTeam) {
    userTeams = await getUserAvailableTeams(user.id, teamId);
    credentials = getTeamAppCredentials(userTeams, credentials, includeTeamInstalledApps);
  }

  const enabledApps = await getEnabledAppsFromCredentials(credentials, {
    filterOnCredentials: onlyInstalled,
    ...(appId ? { where: { slug: appId } } : {}),
  });
  //TODO: Refactor this to pick up only needed fields and prevent more leaking
  let apps = await Promise.all(
    enabledApps.map(async ({ credentials: _, credential, key: _2 /* don't leak to frontend */, ...app }) => {
      const userCredentialIds = credentials.filter((c) => c.appId === app.slug && !c.teamId).map((c) => c.id);
      const invalidCredentialIds = credentials
        .filter((c) => c.appId === app.slug && c.invalid)
        .map((c) => c.id);
      const teams = await constructUserTeams(credentials, app.slug, userTeams);
      const dependencyData = getAppDependencyData(enabledApps, app.dependencies);
      const isSetupAlready = await checkAppSetupStatus(
        credential,
        app.categories.includes("payment"),
        app.dirName
      );

      // type infer as CredentialOwner
      const credentialOwner: CredentialOwner = {
        name: user.name,
        avatar: user.avatar,
      };

      const appData = {
        ...app,
        ...(teams.length && {
          credentialOwner,
        }),
        userCredentialIds,
        invalidCredentialIds,
        teams,
        isInstalled: !!userCredentialIds.length || !!teams.length || app.isGlobal,
        isSetupAlready,
        ...(app.dependencies && { dependencyData }),
      };

      return appData;
    })
  );

  if (variant) {
    // `flatMap()` these work like `.filter()` but infers the types correctly
    apps = apps
      // variant check
      .flatMap((item) => (item.variant.startsWith(variant) ? [item] : []));
  }

  if (exclude) {
    // exclusion filter
    apps = apps.filter((item) => (exclude ? !exclude.includes(item.variant) : true));
  }

  if (onlyInstalled) {
    apps = apps.flatMap((item) =>
      item.userCredentialIds.length > 0 || item.teams.length || item.isGlobal ? [item] : []
    );
  }

  if (extendsFeature) {
    apps = apps
      .filter((app) => app.extendsFeature?.includes(extendsFeature))
      .map((app) => ({
        ...app,
        isInstalled: !!app.userCredentialIds?.length || !!app.teams?.length || app.isGlobal,
      }));
  }

  if (sortByMostPopular) {
    const installCountPerApp = await getInstallCountPerApp();

    // sort the apps array by the most popular apps
    apps.sort((a, b) => {
      const aCount = installCountPerApp[a.slug] || 0;
      const bCount = installCountPerApp[b.slug] || 0;
      return bCount - aCount;
    });
  }

  return {
    items: apps,
  };
};
