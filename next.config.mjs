/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    serverComponentsExternalPackages: ['pdfkit', 'imapflow', 'mailparser', 'nodemailer'],
  },
};

export default nextConfig;
