import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["ssh2", "exceljs", "node-cron", "nodemailer"],
};

export default nextConfig;
