/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    instrumentationHook: true,
    serverComponentsExternalPackages: ['pdfkit', 'imapflow', 'mailparser', 'nodemailer'],
  },
};

export default nextConfig;
