import * as fs from 'fs/promises';
import * as path from 'path';
import matter from 'gray-matter';
import {
  SlashCommandConfig,
  SubagentConfig,
  ConfigFilesResult
} from '../types/claude-config.types.js';
import { logger } from '../../utils/logger.js';

/**
 * Service for writing Claude Code configuration files to workspace
 * Handles MCP servers, slash commands, and subagents
 */
export class ClaudeConfigService {
  /**
   * Write all Claude configuration files to workspace
   * Returns list of created files for git exclusion
   */
  async writeConfigFiles(
    workspaceRoot: string,
    mcpConfig?: Record<string, any>,
    slashCommands?: Record<string, SlashCommandConfig>,
    subagents?: Record<string, SubagentConfig>,
    environmentSecrets?: Record<string, string>
  ): Promise<ConfigFilesResult> {
    const createdFiles: string[] = [];
    let mcpConfigCreated = false;
    let slashCommandsCount = 0;
    let subagentsCount = 0;

    logger.debug(`Writing Claude configuration files to: ${workspaceRoot}`);

    // Write MCP configuration
    if (mcpConfig && Object.keys(mcpConfig).length > 0) {
      const mcpFile = await this.writeMcpConfig(
        workspaceRoot,
        mcpConfig,
        environmentSecrets || {}
      );
      createdFiles.push(mcpFile);
      mcpConfigCreated = true;
      logger.debug(`✓ Created .mcp.json`);
    }

    // Write slash commands
    if (slashCommands && Object.keys(slashCommands).length > 0) {
      const commandFiles = await this.writeSlashCommands(
        workspaceRoot,
        slashCommands
      );
      createdFiles.push(...commandFiles);
      slashCommandsCount = Object.keys(slashCommands).length;
      logger.debug(`✓ Created ${slashCommandsCount} slash commands`);
    }

    // Write subagents
    if (subagents && Object.keys(subagents).length > 0) {
      const agentFiles = await this.writeSubagents(
        workspaceRoot,
        subagents
      );
      createdFiles.push(...agentFiles);
      subagentsCount = Object.keys(subagents).length;
      logger.debug(`✓ Created ${subagentsCount} subagents`);
    }

    logger.info(`Claude configuration files written: ${createdFiles.length} files (MCP config: ${mcpConfigCreated}, ${slashCommandsCount} commands, ${subagentsCount} agents)`);

    return {
      createdFiles,
      summary: {
        mcpConfigCreated,
        slashCommandsCount,
        subagentsCount
      }
    };
  }

  /**
   * Write .mcp.json file with MCP server configurations
   * Accepts raw MCP config JSON - Claude Code will handle ${VAR} expansion
   */
  private async writeMcpConfig(
    workspaceRoot: string,
    mcpConfig: Record<string, any>,
    environmentSecrets: Record<string, string>
  ): Promise<string> {
    const mcpConfigPath = path.join(workspaceRoot, '.mcp.json');

    // Validate that referenced environment variables are defined
    this.validateEnvVarsInObject(mcpConfig, environmentSecrets);

    // Write raw config - Claude Code will expand ${VAR} references
    const mcpConfigJson = JSON.stringify(mcpConfig, null, 2);
    await fs.writeFile(mcpConfigPath, mcpConfigJson, 'utf-8');

    logger.debug(`MCP config content:\n${mcpConfigJson}`);

    return '.mcp.json';
  }

  /**
   * Recursively validate environment variable references in an object
   * Warns about undefined variables but doesn't fail
   */
  private validateEnvVarsInObject(
    obj: any,
    environmentSecrets: Record<string, string>,
    path: string = 'mcpConfig'
  ): void {
    if (typeof obj === 'string') {
      // Find all ${VAR} references
      const matches = obj.matchAll(/\$\{([^}]+)\}/g);
      for (const match of matches) {
        const varName = match[1];
        if (!(varName in environmentSecrets)) {
          logger.warn(`Environment variable "${varName}" referenced in ${path} but not defined in environmentSecrets`);
        }
      }
    } else if (Array.isArray(obj)) {
      obj.forEach((item, index) => {
        this.validateEnvVarsInObject(item, environmentSecrets, `${path}[${index}]`);
      });
    } else if (obj !== null && typeof obj === 'object') {
      for (const [key, value] of Object.entries(obj)) {
        this.validateEnvVarsInObject(value, environmentSecrets, `${path}.${key}`);
      }
    }
  }

  /**
   * Write slash command markdown files
   */
  private async writeSlashCommands(
    workspaceRoot: string,
    commands: Record<string, SlashCommandConfig>
  ): Promise<string[]> {
    const commandsDir = path.join(workspaceRoot, '.claude', 'commands');
    const createdFiles: string[] = [];

    // Create directory
    await fs.mkdir(commandsDir, { recursive: true });

    // Write each command file
    for (const [name, config] of Object.entries(commands)) {
      const fileName = `${name}.md`;
      const filePath = path.join(commandsDir, fileName);

      // Generate markdown content with proper YAML frontmatter
      let content: string;

      // Add frontmatter if provided using gray-matter for proper serialization
      if (config.frontmatter && Object.keys(config.frontmatter).length > 0) {
        content = this.formatMarkdownWithFrontmatter(config.frontmatter, config.content);
      } else {
        content = config.content;
      }

      // Ensure trailing newline
      if (!content.endsWith('\n')) {
        content += '\n';
      }

      // Write file
      await fs.writeFile(filePath, content, 'utf-8');

      createdFiles.push(path.join('.claude', 'commands', fileName));
    }

    return createdFiles;
  }

  /**
   * Write subagent markdown files
   */
  private async writeSubagents(
    workspaceRoot: string,
    agents: Record<string, SubagentConfig>
  ): Promise<string[]> {
    const agentsDir = path.join(workspaceRoot, '.claude', 'agents');
    const createdFiles: string[] = [];

    // Create directory
    await fs.mkdir(agentsDir, { recursive: true });

    // Write each agent file
    for (const [name, config] of Object.entries(agents)) {
      const fileName = `${name}.md`;
      const filePath = path.join(agentsDir, fileName);

      // Generate markdown content with proper YAML frontmatter using gray-matter
      let content = this.formatMarkdownWithFrontmatter(config.frontmatter, config.content);

      // Ensure trailing newline
      if (!content.endsWith('\n')) {
        content += '\n';
      }

      // Write file
      await fs.writeFile(filePath, content, 'utf-8');

      createdFiles.push(path.join('.claude', 'agents', fileName));
    }

    return createdFiles;
  }


  /**
   * Format markdown content with YAML frontmatter using gray-matter
   * Properly handles special characters, quotes, newlines, and XML-like tags
   */
  private formatMarkdownWithFrontmatter(
    frontmatter: Record<string, any>,
    content: string
  ): string {
    // Filter out null/undefined values before serialization
    const filteredFrontmatter: Record<string, any> = {};
    for (const [key, value] of Object.entries(frontmatter)) {
      if (value !== undefined && value !== null) {
        filteredFrontmatter[key] = value;
      }
    }

    // Use gray-matter's stringify for proper YAML serialization
    // This handles all edge cases: quotes, newlines, XML tags, special characters
    return matter.stringify(content, filteredFrontmatter);
  }
}
