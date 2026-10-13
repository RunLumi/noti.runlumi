import type { GithubAppConfig } from './install';

type AppEnv = {
  GITHUB_APP_ID: string;
  GITHUB_APP_SLUG: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  APP_ORIGIN: string;
};

const PLACEHOLDER = /^(|REPLACE_.*|replace-me|0+)$/;

/** The App configuration, or null while any part is still a placeholder (fail closed). */
export function githubAppConfig(env: AppEnv): GithubAppConfig | null {
  const values = [env.GITHUB_APP_ID, env.GITHUB_APP_SLUG, env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET];
  if (values.some((v) => !v || PLACEHOLDER.test(v))) return null;
  if (!/^[1-9][0-9]*$/.test(env.GITHUB_APP_ID) || !/^[a-z0-9-]{1,100}$/i.test(env.GITHUB_APP_SLUG))
    return null;
  return {
    appId: env.GITHUB_APP_ID,
    appSlug: env.GITHUB_APP_SLUG,
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    appOrigin: env.APP_ORIGIN,
  };
}
