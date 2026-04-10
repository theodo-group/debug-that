export interface GlobalFlags {
	session: string;
	json: boolean;
	color: boolean;
	verbose: boolean;
	helpAgent: boolean;
	help: boolean;
	version: boolean;
}

export interface ParsedArgs {
	command: string;
	subcommand: string | null;
	positionals: string[];
	flags: Record<string, string | boolean>;
	global: GlobalFlags;
}

export type CommandHandler = (args: ParsedArgs) => Promise<number>;

export interface CommandDef {
	name: string;
	description: string;
	usage: string;
	handler: CommandHandler;
}
