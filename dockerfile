# Use an official Node runtime as a parent image
FROM node:16

# Set the working directory in the container
WORKDIR /app


RUN apt-get update && apt-get install -y python3 python3-pip

# Copy package.json and package-lock.json (if available) to the working directory
COPY package*.json ./

# Install any dependencies
RUN npm install

# Copy the rest of the application code to the working directory
COPY . .

RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Make port available to the world outside this container
EXPOSE 3001
EXPOSE 2000-2100:2000-2100  

# Define the command to run the app
CMD ["npm", "start"]
