# Maps Server (TileServer GL)

This directory contains the Ansible playbook and Docker Compose configuration to deploy a self-hosted maps server using [TileServer GL](https://github.com/maptiler/tileserver-gl).

## Deployment

To deploy the Maps Server, use the provided Ansible playbook (`deploy.yml`).

### 1. Configure the deployment

First, copy the example variables file to create your local `vars.yml`:

```bash
cp vars.example.yml vars.yml
```

Edit `vars.yml` to specify the `app_dir` (the path on the remote server where the application will be deployed). By default, this is `/opt/maps_server`.

### 2. Provide Map Data (`.mbtiles`)

TileServer GL requires map data in the `.mbtiles` format (vector or raster) to function. 

**Where to put it on the server:**
You must provide a `data.mbtiles` file (or any `.mbtiles` file) and place it directly inside the directory specified by your `app_dir` variable on the **remote server** (e.g., `/opt/maps_server/data.mbtiles`). 

The `docker-compose.yml` file is configured to mount its current directory (`./`) to the container's `/data` folder. This means any `.mbtiles` file placed in the `app_dir` alongside the `docker-compose.yml` file will be automatically recognized and served by TileServer GL.

*Example command to upload the file after creating the folder on the server:*
```bash
scp ./data.mbtiles user@your-server-ip:/opt/maps_server/
```

### 3. Run the Playbook

Run the playbook against your target host to deploy the Docker Compose stack. If you have an inventory file:

```bash
ansible-playbook -i inventory.ini deploy.yml
```

Or specifying the target host directly via SSH:

```bash
ansible-playbook -i "your-server-ip," -u your-ssh-user deploy.yml
```

The playbook will create the necessary deployment directory, copy the `docker-compose.yml` configuration, and spin up the TileServer GL container.

Once the container is running and your `.mbtiles` file has been uploaded to the `app_dir`, the Maps Server UI and tile endpoints will be accessible at `http://your-server-ip:3030`.
