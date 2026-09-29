import { cn } from "cn";
import { VERSION } from "snoboard/browser";
import { useData } from "vike-react/useData";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { LoginPageData } from "./+data.js";

function signInDescription(data: LoginPageData): string {
  if (data.password && data.github) return "Open the board with a password or GitHub.";
  if (data.github) return "Open the board with GitHub.";
  if (data.password) return "Open the board with the shared password.";
  return "Sign-in is not configured.";
}

export function Page() {
  const data = useData<LoginPageData>();

  return (
    <main className="mx-auto flex w-full max-w-lg flex-col gap-6 p-6">
      <Card>
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>{signInDescription(data)}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {data.password ? (
            <form className="flex flex-col gap-4" method="post" action="/auth/password">
              <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="password">
                Password
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </label>
              <Button type="submit">Sign in</Button>
            </form>
          ) : null}
          {data.password && data.github ? (
            <p className="text-center text-sm text-muted-foreground">or</p>
          ) : null}
          {data.github ? (
            <a className={cn(buttonVariants({ variant: "outline" }), "w-full")} href="/auth/github">
              Sign in with GitHub
            </a>
          ) : null}
          {!data.password && !data.github ? (
            <p className="text-sm text-muted-foreground">Sign-in is not configured.</p>
          ) : null}
        </CardContent>
      </Card>
      <footer className="text-sm text-muted-foreground">Snoboard {VERSION}</footer>
    </main>
  );
}
